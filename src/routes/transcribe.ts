import { Router, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import { getCachedVideo } from "../services/video-cache.js";
import { extractAudio, extractFullAudio } from "../services/ffmpeg.js";
import { transcribeAudio, transcribeAudioFull } from "../services/elevenlabs.js";
import { getSignedSourceUrl } from "../services/firebase.js";
import { getEnv } from "../config/env.js";

const router = Router();

/**
 * Run an FFmpeg-based extractor first via HTTP streaming from a signed URL,
 * then — only if that fails (typically non-faststart MP4s) — fall back to
 * downloading the full source into the LRU cache.
 *
 * Skips HTTP streaming entirely for `.mov` files: iPhone-recorded .mov has
 * the moov atom at the END of the file, so ffmpeg has to scan the whole
 * thing over slow droplet HTTP to find it. The local-cache path does a
 * single large GET which is dramatically faster.
 */
async function withStreamingFallback<T>(
  videoStoragePath: string,
  logTag: string,
  run: (input: string) => Promise<T>,
): Promise<T> {
  const ext = path.extname(videoStoragePath).toLowerCase();
  const canStream = ext !== ".mov";

  if (canStream) {
    try {
      const signedUrl = await getSignedSourceUrl(videoStoragePath);
      return await run(signedUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[${logTag}] streaming failed (${msg}), falling back to full download`,
      );
    }
  } else {
    console.log(
      `[${logTag}] skipping HTTP streaming for ${ext} (likely non-faststart) — using cached download path`,
    );
  }
  const localPath = await getCachedVideo(videoStoragePath);
  return run(localPath);
}

router.post("/transcribe", requireApiKey, async (req: Request, res: Response) => {
  const { videoStoragePath, startSeconds, endSeconds } = req.body;

  if (!videoStoragePath || startSeconds == null || endSeconds == null) {
    res.status(400).json({ error: "videoStoragePath, startSeconds, and endSeconds are required" });
    return;
  }

  if (endSeconds <= startSeconds) {
    res.status(400).json({ error: "endSeconds must be greater than startSeconds" });
    return;
  }

  const tempId = crypto.randomUUID();
  const outputDir = getEnv().CLIP_OUTPUT_DIR;
  fs.mkdirSync(outputDir, { recursive: true });
  const mp3Path = path.join(outputDir, `transcribe-${tempId}.mp3`);

  try {
    console.log(`[transcribe] Starting: ${videoStoragePath} [${startSeconds}s–${endSeconds}s]`);

    await withStreamingFallback(videoStoragePath, "transcribe", (input) =>
      extractAudio({ input, startSeconds, endSeconds, outputPath: mp3Path }),
    );

    const text = await transcribeAudio(mp3Path);

    res.json({ text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[transcribe] Failed:`, msg);
    res.status(500).json({ error: msg });
  } finally {
    if (fs.existsSync(mp3Path)) {
      fs.unlinkSync(mp3Path);
    }
  }
});

router.post("/transcribe-full", requireApiKey, async (req: Request, res: Response) => {
  const { videoStoragePath, diarize } = req.body;

  if (!videoStoragePath) {
    res.status(400).json({ error: "videoStoragePath is required" });
    return;
  }

  const tempId = crypto.randomUUID();
  const outputDir = getEnv().CLIP_OUTPUT_DIR;
  fs.mkdirSync(outputDir, { recursive: true });
  const oggPath = path.join(outputDir, `transcribe-full-${tempId}.ogg`);

  try {
    console.log(`[transcribe-full] Starting: ${videoStoragePath} (diarize=${!!diarize})`);

    await withStreamingFallback(videoStoragePath, "transcribe-full", (input) =>
      extractFullAudio({ input, outputPath: oggPath }),
    );

    const result = await transcribeAudioFull(oggPath, !!diarize);

    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[transcribe-full] Failed:`, msg);
    res.status(500).json({ error: msg });
  } finally {
    if (fs.existsSync(oggPath)) {
      fs.unlinkSync(oggPath);
    }
  }
});

export default router;

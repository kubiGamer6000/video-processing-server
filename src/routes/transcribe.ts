import { Router, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import { getCachedVideo } from "../services/video-cache.js";
import { extractAudio, extractFullAudio } from "../services/ffmpeg.js";
import { transcribeAudio, transcribeAudioFull } from "../services/elevenlabs.js";
import { getSignedSourceUrl } from "../services/firebase.js";
import { getFaststartStoragePath, migrateToFaststart } from "../services/faststart.js";
import { getEnv } from "../config/env.js";

const router = Router();

/**
 * Run an FFmpeg-based extractor:
 *   1. If the source is .mp4, stream directly from a signed Firebase URL.
 *   2. If the source is .mov AND a faststart .mp4 sidecar already exists
 *      (created lazily by a prior crop or transcription), stream that.
 *   3. Otherwise download the .mov into the LRU cache, run the extractor
 *      locally, then schedule a background faststart migration so the
 *      NEXT request can use path 2 above.
 *
 * iPhone-recorded .mov files have the moov atom at the END so streaming
 * them without a faststart sidecar is pathologically slow (5+ minutes of
 * appears-frozen behaviour). The migration step is what turns those into
 * proper streaming videos once and for all.
 */
async function withStreamingFallback<T>(
  videoStoragePath: string,
  logTag: string,
  run: (input: string) => Promise<T>,
): Promise<T> {
  const ext = path.extname(videoStoragePath).toLowerCase();

  let streamablePath: string | null = null;
  if (ext === ".mov") {
    streamablePath = await getFaststartStoragePath(videoStoragePath);
  } else {
    streamablePath = videoStoragePath;
  }

  if (streamablePath) {
    try {
      const signedUrl = await getSignedSourceUrl(streamablePath);
      console.log(
        `[${logTag}] streaming from ${streamablePath === videoStoragePath ? "original" : "faststart sidecar"}`,
      );
      return await run(signedUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[${logTag}] streaming failed (${msg}), falling back to full download`,
      );
    }
  } else {
    console.log(
      `[${logTag}] no faststart sidecar for .mov — using cached download path ` +
        `(will create sidecar in background)`,
    );
  }

  const localPath = await getCachedVideo(videoStoragePath);
  const result = await run(localPath);

  if (ext === ".mov" && streamablePath === null) {
    void migrateToFaststart({
      localMovPath: localPath,
      originalStoragePath: videoStoragePath,
    });
  }

  return result;
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

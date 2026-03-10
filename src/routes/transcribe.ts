import { Router, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import { getCachedVideo } from "../services/video-cache.js";
import { extractAudio } from "../services/ffmpeg.js";
import { transcribeAudio } from "../services/elevenlabs.js";
import { getEnv } from "../config/env.js";

const router = Router();

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

    const videoPath = await getCachedVideo(videoStoragePath);

    await extractAudio({
      inputPath: videoPath,
      startSeconds,
      endSeconds,
      outputPath: mp3Path,
    });

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

export default router;

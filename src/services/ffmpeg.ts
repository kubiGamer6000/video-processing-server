import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.js";

const execFileAsync = promisify(execFile);

function ensureOutputDir(): string {
  const dir = getEnv().CLIP_OUTPUT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function formatSeconds(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export interface CropOptions {
  inputPath: string;
  segmentId: string;
  startSeconds: number;
  endSeconds: number;
}

/**
 * Crops a segment from a video using FFmpeg stream copy (no re-encode).
 * Places -ss before -i for fast seeking, uses -t for duration.
 * Returns the path to the output clip.
 */
export async function cropSegment(opts: CropOptions): Promise<string> {
  const outputDir = ensureOutputDir();
  const outputPath = path.join(outputDir, `${opts.segmentId}.mp4`);
  const duration = opts.endSeconds - opts.startSeconds;

  const args = [
    "-ss", formatSeconds(opts.startSeconds),
    "-i", opts.inputPath,
    "-t", String(duration),
    "-c", "copy",
    "-y",
    outputPath,
  ];

  console.log(`FFmpeg crop: ${opts.segmentId} [${opts.startSeconds}s–${opts.endSeconds}s]`);

  try {
    await execFileAsync("ffmpeg", args, { timeout: 120_000 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`FFmpeg failed for ${opts.segmentId}: ${msg}`);
  }

  return outputPath;
}

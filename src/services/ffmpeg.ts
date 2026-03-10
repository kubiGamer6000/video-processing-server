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

export interface ExtractAudioOptions {
  inputPath: string;
  startSeconds: number;
  endSeconds: number;
  outputPath: string;
}

const PADDING_SECONDS = 2;

/**
 * Crops a segment from a video using FFmpeg stream copy (no re-encode).
 * Places -ss before -i for fast seeking, uses -t for duration.
 * Adds 2s padding before and after the segment for clean cuts.
 * Returns the path to the output clip.
 */
export async function cropSegment(opts: CropOptions): Promise<string> {
  const outputDir = ensureOutputDir();
  const outputPath = path.join(outputDir, `${opts.segmentId}.mp4`);

  const paddedStart = Math.max(0, opts.startSeconds - PADDING_SECONDS);
  const paddedEnd = opts.endSeconds + PADDING_SECONDS;
  const duration = paddedEnd - paddedStart;

  const args = [
    "-ss", formatSeconds(paddedStart),
    "-i", opts.inputPath,
    "-t", String(duration),
    "-c", "copy",
    "-y",
    outputPath,
  ];

  console.log(`FFmpeg crop: ${opts.segmentId} [${paddedStart}s–${paddedEnd}s] (original ${opts.startSeconds}s–${opts.endSeconds}s, ±${PADDING_SECONDS}s pad)`);

  try {
    await execFileAsync("ffmpeg", args, { timeout: 120_000 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`FFmpeg failed for ${opts.segmentId}: ${msg}`);
  }

  return outputPath;
}

/**
 * Extracts audio from a video for a given time range as MP3.
 * Uses -ss before -i for fast seeking. Audio-only, no video re-encoding.
 */
export async function extractAudio(opts: ExtractAudioOptions): Promise<string> {
  const duration = opts.endSeconds - opts.startSeconds;

  const args = [
    "-ss", formatSeconds(opts.startSeconds),
    "-i", opts.inputPath,
    "-t", String(duration),
    "-vn",
    "-acodec", "libmp3lame",
    "-q:a", "4",
    "-y",
    opts.outputPath,
  ];

  console.log(`FFmpeg audio extract: [${opts.startSeconds}s–${opts.endSeconds}s] → ${opts.outputPath}`);

  try {
    await execFileAsync("ffmpeg", args, { timeout: 120_000 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`FFmpeg audio extraction failed: ${msg}`);
  }

  return opts.outputPath;
}

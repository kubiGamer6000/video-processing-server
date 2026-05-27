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

function isHttpUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

/**
 * Flags to put BEFORE `-i <url>` when reading from an HTTP source. Enables
 * automatic reconnect and tells FFmpeg the stream is seekable (so it uses
 * HTTP range requests to jump to `-ss` instead of downloading sequentially).
 *
 * Crucially, these only work when placed before `-i`.
 */
function httpInputFlags(): string[] {
  return [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-seekable", "1",
  ];
}

export interface CropOptions {
  /** Local path on disk OR an http(s):// URL (Firebase signed URL). */
  input: string;
  segmentId: string;
  startSeconds: number;
  endSeconds: number;
}

export interface ExtractAudioOptions {
  /** Local path on disk OR an http(s):// URL. */
  input: string;
  startSeconds: number;
  endSeconds: number;
  outputPath: string;
}

const PADDING_SECONDS = 2;

/**
 * Crops a segment from a video using FFmpeg stream copy (no re-encode).
 *
 * Places `-ss` before `-i` so FFmpeg seeks by byte offset (instant on
 * keyframe-aligned MP4s; for HTTP inputs this means it uses range requests
 * to only fetch the bytes for the segment + some lookahead, instead of
 * downloading the whole file).
 *
 * Adds 2s padding before and after the segment for clean cuts.
 * Returns the path to the output clip.
 */
export async function cropSegment(opts: CropOptions): Promise<string> {
  const outputDir = ensureOutputDir();
  const outputPath = path.join(outputDir, `${opts.segmentId}.mp4`);

  const paddedStart = Math.max(0, opts.startSeconds - PADDING_SECONDS);
  const paddedEnd = opts.endSeconds + PADDING_SECONDS;
  const duration = paddedEnd - paddedStart;

  const usingHttp = isHttpUrl(opts.input);

  const args = [
    ...(usingHttp ? httpInputFlags() : []),
    "-ss", formatSeconds(paddedStart),
    "-i", opts.input,
    "-t", String(duration),
    "-c", "copy",
    "-y",
    outputPath,
  ];

  console.log(
    `FFmpeg crop: ${opts.segmentId} [${paddedStart}s–${paddedEnd}s] ` +
      `(original ${opts.startSeconds}s–${opts.endSeconds}s, ±${PADDING_SECONDS}s pad) ` +
      `via ${usingHttp ? "stream (HTTP)" : "local"}`,
  );

  try {
    // HTTP can be slower to first byte on a fresh connection — give it more
    // headroom than the local-disk case but still bounded.
    const timeout = usingHttp ? 300_000 : 120_000;
    await execFileAsync("ffmpeg", args, { timeout });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`FFmpeg failed for ${opts.segmentId}: ${msg}`);
  }

  return outputPath;
}

/**
 * Extracts audio from a video for a given time range as MP3.
 * Uses `-ss` before `-i` for fast seeking. Audio-only, no video re-encoding.
 */
export async function extractAudio(opts: ExtractAudioOptions): Promise<string> {
  const duration = opts.endSeconds - opts.startSeconds;
  const usingHttp = isHttpUrl(opts.input);

  const args = [
    ...(usingHttp ? httpInputFlags() : []),
    "-ss", formatSeconds(opts.startSeconds),
    "-i", opts.input,
    "-t", String(duration),
    "-vn",
    "-acodec", "libmp3lame",
    "-q:a", "4",
    "-y",
    opts.outputPath,
  ];

  console.log(
    `FFmpeg audio extract: [${opts.startSeconds}s–${opts.endSeconds}s] → ${opts.outputPath} ` +
      `via ${usingHttp ? "stream (HTTP)" : "local"}`,
  );

  try {
    const timeout = usingHttp ? 300_000 : 120_000;
    await execFileAsync("ffmpeg", args, { timeout });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`FFmpeg audio extraction failed: ${msg}`);
  }

  return opts.outputPath;
}

export interface ExtractFullAudioOptions {
  /** Local path on disk OR an http(s):// URL. */
  input: string;
  outputPath: string;
}

/**
 * Extracts the full audio track from a video as compressed OGG (Opus).
 * Optimised for speech-to-text: 16 kHz mono, 32 kbps VoIP preset.
 *
 * NOTE: this reads the WHOLE input from start to end, so HTTP streaming
 * doesn't give a huge speedup here — but it still avoids buffering the
 * entire video on disk before audio extraction starts.
 */
export async function extractFullAudio(opts: ExtractFullAudioOptions): Promise<string> {
  const usingHttp = isHttpUrl(opts.input);

  const args = [
    ...(usingHttp ? httpInputFlags() : []),
    "-i", opts.input,
    "-vn",
    "-ar", "16000",
    "-ac", "1",
    "-c:a", "libopus",
    "-b:a", "32k",
    "-application", "voip",
    "-y",
    opts.outputPath,
  ];

  console.log(
    `FFmpeg full audio extract: ${opts.input.slice(0, 120)} → ${opts.outputPath} ` +
      `via ${usingHttp ? "stream (HTTP)" : "local"}`,
  );

  try {
    await execFileAsync("ffmpeg", args, { timeout: 900_000 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`FFmpeg full audio extraction failed: ${msg}`);
  }

  return opts.outputPath;
}

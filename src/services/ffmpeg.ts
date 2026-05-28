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

// Output quality settings.
//
// We re-encode (no `-c copy`) for three reasons:
//   1. Caps the long edge at 1080p, so 4K/HEVC sources don't produce 80MB
//      clips for a 5-second segment.
//   2. CRF 20 + libx264 looks essentially identical to source for hand-held
//      video, while shrinking files 5-10×.
//   3. Re-encoding sidesteps the `-c copy` + `-ss` keyframe-alignment bug
//      that produced clips with the wrong duration on iPhone HEVC and Sony
//      XAVC sources.
//
// `veryfast` keeps wall-clock encode time below realtime on a 4-vCPU droplet
// at 1080p — a 9-second segment encodes in ~3-6s after seek.
const VIDEO_PRESET = "veryfast";
const VIDEO_CRF = "20";
const AUDIO_BITRATE = "192k";
// Long-edge cap of 1920px (= 1080p in either orientation):
//   landscape 3840x2160 → 1920x1080
//   portrait  2160x3840 → 1080x1920
// Sources already ≤1080p on the long edge are left at native size (no upscale).
const SCALE_FILTER =
  "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'";

/**
 * Crops a segment from a video and re-encodes it to 1080p H.264 at CRF 20.
 *
 * Places `-ss` before `-i` so FFmpeg seeks by byte offset (instant on
 * faststart MP4s; for HTTP inputs this means range requests to only fetch
 * the bytes for the segment + some lookahead, not the whole file).
 *
 * Adds 2s padding before and after the segment for clean cuts.
 * Output is faststart MP4 (moov at the front) so the clip is range-seekable
 * the moment it lands in Firebase Storage.
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
    // Drop anything that's not the first video + first audio (no Dolby Vision
    // RPU, no timed-metadata streams, etc.) — keeps the output a clean
    // browser-playable MP4.
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", SCALE_FILTER,
    "-c:v", "libx264",
    "-preset", VIDEO_PRESET,
    "-crf", VIDEO_CRF,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", AUDIO_BITRATE,
    "-movflags", "+faststart",
    "-y",
    outputPath,
  ];

  console.log(
    `FFmpeg crop: ${opts.segmentId} [${paddedStart}s–${paddedEnd}s] ` +
      `(original ${opts.startSeconds}s–${opts.endSeconds}s, ±${PADDING_SECONDS}s pad) ` +
      `→ 1080p H.264 CRF${VIDEO_CRF} via ${usingHttp ? "stream (HTTP)" : "local"}`,
  );

  try {
    // Re-encoding takes longer than stream copy. Give HTTP inputs even more
    // headroom because first-byte latency stacks on top of encode time.
    const timeout = usingHttp ? 600_000 : 300_000;
    await execFileAsync("ffmpeg", args, {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err: unknown) {
    // execFile's default error message swallows stderr; pull it out so the
    // logs actually show why FFmpeg failed.
    const e = err as { message?: string; stderr?: string | Buffer; code?: number };
    const stderrTail = (e.stderr ? String(e.stderr) : "").split("\n").slice(-20).join("\n");
    throw new Error(
      `FFmpeg failed for ${opts.segmentId} (exit=${e.code ?? "?"}): ${e.message ?? "unknown"}\n` +
        `--- stderr (last 20 lines) ---\n${stderrTail}`,
    );
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
    await execFileAsync("ffmpeg", args, { timeout, maxBuffer: 16 * 1024 * 1024 });
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string | Buffer; code?: number };
    const stderrTail = (e.stderr ? String(e.stderr) : "").split("\n").slice(-20).join("\n");
    throw new Error(
      `FFmpeg audio extraction failed (exit=${e.code ?? "?"}): ${e.message ?? "unknown"}\n` +
        `--- stderr (last 20 lines) ---\n${stderrTail}`,
    );
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
    await execFileAsync("ffmpeg", args, { timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string | Buffer; code?: number };
    const stderrTail = (e.stderr ? String(e.stderr) : "").split("\n").slice(-20).join("\n");
    throw new Error(
      `FFmpeg full audio extraction failed (exit=${e.code ?? "?"}): ${e.message ?? "unknown"}\n` +
        `--- stderr (last 20 lines) ---\n${stderrTail}`,
    );
  }

  return opts.outputPath;
}

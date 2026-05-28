import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.js";

/**
 * Run ffmpeg with LIVE stderr streaming + stall detection.
 *
 * Why this exists: execFile's buffered behaviour hides ffmpeg progress until
 * the process exits. When the input is a non-faststart iPhone .mov over
 * HTTP, ffmpeg sits there scanning the file for the moov atom for minutes
 * with zero pm2-visible output. Result: looks frozen, debugging impossible,
 * and we can't decide to give up early.
 *
 * With spawn + stderr piped, we:
 *   - print every ffmpeg stderr line as it arrives → pm2 logs show progress
 *   - watch the gap between lines → if ffmpeg hasn't said anything in
 *     `stallMs`, assume it's hung on a stuck HTTP read and SIGKILL it
 *   - apply a hard ceiling timeout (totalMs) so a slow-but-progressing
 *     stream still can't drag on forever
 *
 * Returns a Promise that resolves on exit code 0 and rejects with the last
 * 30 stderr lines on any failure (timeout, stall, non-zero exit).
 */
interface SpawnOpts {
  args: string[];
  /** Tag printed before each stderr line (e.g. segment id) */
  logTag: string;
  /** Kill if no stderr line received within this many ms. Default: 30s. */
  stallMs?: number;
  /** Hard wallclock ceiling regardless of activity. Default: 300s. */
  totalMs?: number;
}

async function runFfmpeg(opts: SpawnOpts): Promise<void> {
  const stallMs = opts.stallMs ?? 30_000;
  const totalMs = opts.totalMs ?? 300_000;

  return new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn("ffmpeg", opts.args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderrBuf = "";
    let partial = "";
    let lastLineAt = Date.now();

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      partial += text;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          lastLineAt = Date.now();
          console.log(`[ffmpeg ${opts.logTag}] ${trimmed}`);
        }
      }
    };
    child.stderr.on("data", onChunk);

    const stallTimer = setInterval(() => {
      const idle = Date.now() - lastLineAt;
      if (idle > stallMs) {
        clearInterval(stallTimer);
        console.warn(
          `[ffmpeg ${opts.logTag}] STALL — no output for ${idle}ms (limit ${stallMs}ms), killing`,
        );
        child.kill("SIGKILL");
      }
    }, 5000);

    const hardTimeout = setTimeout(() => {
      console.warn(
        `[ffmpeg ${opts.logTag}] HARD TIMEOUT — ${totalMs}ms ceiling reached, killing`,
      );
      child.kill("SIGKILL");
    }, totalMs);

    child.on("error", (err) => {
      clearInterval(stallTimer);
      clearTimeout(hardTimeout);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearInterval(stallTimer);
      clearTimeout(hardTimeout);
      const wallMs = Date.now() - t0;
      if (code === 0) {
        console.log(`[ffmpeg ${opts.logTag}] done in ${wallMs}ms`);
        resolve();
        return;
      }
      const stderrTail = stderrBuf.split("\n").slice(-30).join("\n");
      const reason =
        signal === "SIGKILL"
          ? `killed (stall or timeout, ${wallMs}ms)`
          : `exit=${code} (${wallMs}ms)`;
      reject(
        new Error(
          `ffmpeg ${reason}\n--- stderr (last 30 lines) ---\n${stderrTail}`,
        ),
      );
    });
  });
}

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
 * This is the fast path that's been running in production for ages. The
 * dashboard server's `local-crop` pipeline now handles short segments and
 * does the 1080p re-encode itself — re-encoding here on the droplet's
 * 1 vCPU was bringing the worker to 0.03× realtime on 4K sources, which
 * starved transcription requests of CPU.
 *
 * Places `-ss` before `-i` so FFmpeg seeks by byte offset (instant on
 * faststart MP4s; for HTTP inputs this means range requests to only fetch
 * the bytes for the segment + some lookahead, not the whole file).
 *
 * Adds 2s padding before and after the segment for clean cuts.
 */
export async function cropSegment(opts: CropOptions): Promise<string> {
  const outputDir = ensureOutputDir();
  const outputPath = path.join(outputDir, `${opts.segmentId}.mp4`);

  const paddedStart = Math.max(0, opts.startSeconds - PADDING_SECONDS);
  const paddedEnd = opts.endSeconds + PADDING_SECONDS;
  const duration = paddedEnd - paddedStart;

  const usingHttp = isHttpUrl(opts.input);

  const args = [
    "-hide_banner",
    "-loglevel", "info",
    ...(usingHttp ? httpInputFlags() : []),
    "-ss", formatSeconds(paddedStart),
    "-i", opts.input,
    "-t", String(duration),
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    "-y",
    outputPath,
  ];

  console.log(
    `FFmpeg crop: ${opts.segmentId} [${paddedStart}s–${paddedEnd}s] ` +
      `(original ${opts.startSeconds}s–${opts.endSeconds}s, ±${PADDING_SECONDS}s pad) ` +
      `via ${usingHttp ? "stream (HTTP)" : "local"}`,
  );

  // HTTP path: tight stall + hard timeout because we have a local-download
  // fallback. If ffmpeg can't make progress against this URL within 30s,
  // the source is almost certainly a non-faststart MOV and we should give
  // up early and let cropWithFallback() download the file properly.
  // Local path: longer stall budget (slow disks happen), 5-min ceiling.
  await runFfmpeg({
    args,
    logTag: opts.segmentId,
    stallMs: usingHttp ? 30_000 : 60_000,
    totalMs: usingHttp ? 120_000 : 300_000,
  });

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
    "-hide_banner",
    "-loglevel", "info",
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

  await runFfmpeg({
    args,
    logTag: `audio:${path.basename(opts.outputPath)}`,
    stallMs: usingHttp ? 30_000 : 60_000,
    totalMs: usingHttp ? 120_000 : 300_000,
  });

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
    "-hide_banner",
    "-loglevel", "info",
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

  // Full-file read: more permissive stall budget (large files genuinely
  // take time even while making progress), 15-min ceiling for HTTP cases.
  await runFfmpeg({
    args,
    logTag: `full-audio:${path.basename(opts.outputPath)}`,
    stallMs: 60_000,
    totalMs: 900_000,
  });

  return opts.outputPath;
}

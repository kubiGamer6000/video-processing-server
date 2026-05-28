/**
 * Droplet-side diagnostic for the HTTP-streaming crop path.
 *
 * Run this directly on the VPS where segment-worker is deployed. It uses the
 * VPS's own env (.env + pubsub-service-acc.json) so the result matches what
 * the worker actually sees.
 *
 * What it does:
 *   1. Prints FFmpeg version + which protocols/TLS lib are compiled in.
 *   2. Picks a real video from Firestore (or uses --video=<id>).
 *   3. Generates a signed URL the same way services/firebase.ts does.
 *   4. Probes the URL: HEAD + Range GET (the two things FFmpeg streaming
 *      depends on). Prints status codes + headers.
 *   5. Runs the EXACT FFmpeg command production uses for the streaming path
 *      and shows the FULL stderr + exit code. This is the bit we're missing
 *      — the existing log line eats the stderr.
 *   6. If that fails, retries with a couple of alternative invocations so we
 *      can see whether it's a flag issue, a protocol issue, or a network
 *      issue.
 *
 * Usage on the droplet:
 *   cd ~/scandi-video-ai/VIdeoProcessingServer    # or wherever it's deployed
 *   npx tsx src/scripts/diagnose-streaming.ts
 *   npx tsx src/scripts/diagnose-streaming.ts --video=<videoId>
 *   npx tsx src/scripts/diagnose-streaming.ts --start=30 --duration=10
 *
 * Paste the entire output back here.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import admin from "firebase-admin";

const execFileAsync = promisify(execFile);

// ── Config ───────────────────────────────────────────────────────────

interface Args {
  videoId?: string;
  startSeconds: number;
  durationSeconds: number;
}
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = { startSeconds: 30, durationSeconds: 5 };
  for (const x of argv) {
    if (x.startsWith("--video=")) a.videoId = x.split("=")[1];
    else if (x.startsWith("--start=")) a.startSeconds = parseFloat(x.split("=")[1]);
    else if (x.startsWith("--duration=")) a.durationSeconds = parseFloat(x.split("=")[1]);
  }
  return a;
}

const KEY_FILE = process.env.GCP_KEY_FILE || "./pubsub-service-acc.json";
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "scandi-video-ai.firebasestorage.app";

// ── Small UI helpers ─────────────────────────────────────────────────

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function section(title: string) {
  console.log("");
  console.log(C.bold(C.cyan(`━━━ ${title} ${"━".repeat(Math.max(0, 70 - title.length))}`)));
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

function fmtTs(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── FFmpeg version probe ─────────────────────────────────────────────

async function probeFfmpeg() {
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-version"]);
    const lines = stdout.split("\n");
    console.log(lines[0]);
    const config = lines.find((l) => l.startsWith("configuration:")) ?? "";
    const hasOpenssl = config.includes("--enable-openssl");
    const hasGnutls = config.includes("--enable-gnutls");
    const hasLibsrt = config.includes("--enable-libsrt");
    console.log(
      `TLS support: ${
        hasOpenssl ? C.green("openssl ✓") : hasGnutls ? C.green("gnutls ✓") : C.red("NONE — https will fail!")
      }`,
    );
    console.log(C.dim(`(libsrt=${hasLibsrt ? "yes" : "no"})`));

    // Protocol list
    const { stdout: protos } = await execFileAsync("ffmpeg", ["-hide_banner", "-protocols"]);
    const httpsListed = protos.includes("https");
    console.log(`Protocols list ${httpsListed ? "has" : C.red("MISSING")} 'https'`);
  } catch (err) {
    console.log(C.red(`ffmpeg not found or not runnable: ${err instanceof Error ? err.message : String(err)}`));
  }
}

// ── Firebase ─────────────────────────────────────────────────────────

async function initAdmin() {
  if (!fs.existsSync(KEY_FILE)) {
    throw new Error(
      `Service-account key not found at ${KEY_FILE} (resolve relative to cwd=${process.cwd()}).\n` +
        `Set GCP_KEY_FILE in .env or run from the VIdeoProcessingServer directory.`,
    );
  }
  admin.initializeApp({
    credential: admin.credential.cert(KEY_FILE),
    storageBucket: BUCKET,
  });
}

interface VideoRow {
  id: string;
  storagePath: string;
  fileName: string;
}

async function pickVideo(videoId?: string): Promise<VideoRow> {
  const db = admin.firestore();
  if (videoId) {
    const s = await db.collection("videos").doc(videoId).get();
    if (!s.exists) throw new Error(`video ${videoId} not found`);
    return {
      id: s.id,
      storagePath: s.get("storagePath"),
      fileName: s.get("originalFileName") ?? "(unknown)",
    };
  }
  const snap = await db.collection("videos").limit(100).get();
  const candidates = snap.docs
    .map((d) => ({
      id: d.id,
      storagePath: d.get("storagePath") as string | undefined,
      fileName: (d.get("originalFileName") as string | undefined) ?? "(unknown)",
    }))
    .filter((v): v is VideoRow => typeof v.storagePath === "string");
  if (!candidates.length) throw new Error("no videos with storagePath found");
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function getSignedUrl(p: string): Promise<string> {
  const [u] = await admin.storage().bucket().file(p).getSignedUrl({
    action: "read",
    expires: Date.now() + 3600_000,
  });
  return u;
}

// ── HTTP probe ───────────────────────────────────────────────────────

async function probeHttp(url: string) {
  console.log(C.dim(`URL host: ${new URL(url).host}`));
  const t0 = performance.now();
  const head = await fetch(url, { method: "HEAD" });
  const headMs = performance.now() - t0;
  console.log(
    `HEAD  ${head.status}  ${headMs.toFixed(0)}ms  ` +
      `content-length=${head.headers.get("content-length") ?? "—"}  ` +
      `accept-ranges=${head.headers.get("accept-ranges") ?? "—"}  ` +
      `content-type=${head.headers.get("content-type") ?? "—"}`,
  );

  const t1 = performance.now();
  const rng = await fetch(url, { method: "GET", headers: { Range: "bytes=0-1023" } });
  const rngMs = performance.now() - t1;
  console.log(
    `RANGE ${rng.status}  ${rngMs.toFixed(0)}ms  ` +
      `content-range=${rng.headers.get("content-range") ?? "—"}  ` +
      `content-length=${rng.headers.get("content-length") ?? "—"}`,
  );
  await rng.arrayBuffer();

  if (rng.status === 206) {
    console.log(C.green("✓ Range requests work — FFmpeg streaming should be able to seek."));
  } else {
    console.log(
      C.red(
        `✗ Range probe returned ${rng.status} (expected 206). FFmpeg streaming will fall back to a full download.`,
      ),
    );
  }
}

// ── FFmpeg runner that captures stderr ────────────────────────────────

interface FfmpegRun {
  exitCode: number | null;
  stderr: string;
  wallMs: number;
  killedByTimeout: boolean;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<FfmpegRun> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let killed = false;
    const to = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("close", (code) => {
      clearTimeout(to);
      resolve({ exitCode: code, stderr, wallMs: performance.now() - t0, killedByTimeout: killed });
    });
    child.on("error", (err) => {
      clearTimeout(to);
      resolve({
        exitCode: -1,
        stderr: stderr + "\n[spawn error] " + err.message,
        wallMs: performance.now() - t0,
        killedByTimeout: killed,
      });
    });
  });
}

async function ffprobeDuration(p: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      p,
    ]);
    const n = parseFloat(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function buildProductionArgs(opts: {
  url: string;
  startSeconds: number;
  durationSeconds: number;
  outputPath: string;
}): string[] {
  return [
    "-hide_banner",
    "-loglevel", "info",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-seekable", "1",
    "-ss", fmtTs(opts.startSeconds),
    "-i", opts.url,
    "-t", String(opts.durationSeconds),
    "-c", "copy",
    "-y",
    opts.outputPath,
  ];
}

async function runVariant(label: string, args: string[], outPath: string, expectedDur: number) {
  console.log("");
  console.log(C.bold(label));
  console.log(C.dim(`ffmpeg ${args.map((a) => (a.length > 100 ? a.slice(0, 80) + "…[truncated]" : a)).join(" ")}`));
  const r = await runFfmpeg(args, 300_000);

  let outDur: number | null = null;
  let outSize: number | null = null;
  if (r.exitCode === 0 && fs.existsSync(outPath)) {
    outSize = fs.statSync(outPath).size;
    outDur = await ffprobeDuration(outPath);
  }

  const okExit = r.exitCode === 0;
  const okDur = outDur !== null && Math.abs(outDur - expectedDur) <= 0.5;

  if (okExit && okDur) {
    console.log(C.green(`✓ OK: exit=0, ${r.wallMs.toFixed(0)}ms, output=${fmtBytes(outSize ?? 0)}, dur=${outDur?.toFixed(2)}s/${expectedDur}s`));
  } else if (!okExit) {
    console.log(
      C.red(
        `✗ FAIL: exit=${r.exitCode}${r.killedByTimeout ? " (TIMEOUT)" : ""}, ${r.wallMs.toFixed(0)}ms`,
      ),
    );
  } else {
    console.log(
      C.yellow(
        `! WARN: exit=0 but duration mismatch: ${outDur?.toFixed(2)}s (expected ${expectedDur}s), size=${fmtBytes(outSize ?? 0)}`,
      ),
    );
  }

  // Always print the stderr tail — this is the whole point of running on the droplet.
  console.log(C.dim("─── ffmpeg stderr (last 40 lines) ───"));
  console.log(C.dim(r.stderr.split("\n").slice(-40).map((l) => "  │ " + l).join("\n")));
  return { exitCode: r.exitCode, stderr: r.stderr, wallMs: r.wallMs, outDur, outSize };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  section("Environment");
  console.log(`cwd:            ${process.cwd()}`);
  console.log(`node:           ${process.version}`);
  console.log(`GCP_KEY_FILE:   ${KEY_FILE} ${fs.existsSync(KEY_FILE) ? C.green("(exists)") : C.red("(MISSING)")}`);
  console.log(`BUCKET:         ${BUCKET}`);

  section("FFmpeg");
  await probeFfmpeg();

  section("Firestore + signed URL");
  await initAdmin();
  const video = await pickVideo(args.videoId);
  console.log(`videoId:        ${video.id}`);
  console.log(`fileName:       ${video.fileName}`);
  console.log(`storagePath:    ${video.storagePath}`);

  const t0 = performance.now();
  const url = await getSignedUrl(video.storagePath);
  console.log(C.dim(`signed url in ${(performance.now() - t0).toFixed(0)}ms`));
  console.log(C.dim(`(${url.slice(0, 120)}…)`));

  section("HTTP probe");
  await probeHttp(url);

  section("FFmpeg streaming crop — EXACT production command");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scandi-diag-"));
  const out1 = path.join(tmp, "prod.mp4");
  await runVariant(
    "Production: -ss before -i, -c copy",
    buildProductionArgs({ url, startSeconds: args.startSeconds, durationSeconds: args.durationSeconds, outputPath: out1 }),
    out1,
    args.durationSeconds,
  );

  section("Alternative invocations (diagnostic)");

  // Same as production but louder logging (so we see why if it fails)
  const out2 = path.join(tmp, "verbose.mp4");
  await runVariant(
    "Verbose -loglevel debug (same flags)",
    [
      "-hide_banner",
      "-loglevel", "debug",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-seekable", "1",
      "-ss", fmtTs(args.startSeconds),
      "-i", url,
      "-t", String(args.durationSeconds),
      "-c", "copy",
      "-y",
      out2,
    ],
    out2,
    args.durationSeconds,
  );

  // No -seekable hint (default behaviour)
  const out3 = path.join(tmp, "no-seekable.mp4");
  await runVariant(
    "Without -seekable flag",
    [
      "-hide_banner",
      "-loglevel", "info",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-ss", fmtTs(args.startSeconds),
      "-i", url,
      "-t", String(args.durationSeconds),
      "-c", "copy",
      "-y",
      out3,
    ],
    out3,
    args.durationSeconds,
  );

  // Output -ss (won't use range-seek, will read from start) — slowest but most accurate
  const out4 = path.join(tmp, "output-seek.mp4");
  await runVariant(
    "Output -ss (read from start, accurate)",
    [
      "-hide_banner",
      "-loglevel", "info",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-seekable", "1",
      "-i", url,
      "-ss", fmtTs(args.startSeconds),
      "-t", String(args.durationSeconds),
      "-c", "copy",
      "-y",
      out4,
    ],
    out4,
    args.durationSeconds,
  );

  // Re-encode (CPU-heavy but most robust for weird containers)
  const out5 = path.join(tmp, "reencode.mp4");
  await runVariant(
    "Re-encode libx264 ultrafast (slowest, most compatible)",
    [
      "-hide_banner",
      "-loglevel", "info",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-seekable", "1",
      "-ss", fmtTs(args.startSeconds),
      "-i", url,
      "-t", String(args.durationSeconds),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
      "-c:a", "aac", "-b:a", "192k",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-y",
      out5,
    ],
    out5,
    args.durationSeconds,
  );

  section("Done");
  console.log(C.dim(`outputs kept at ${tmp}`));
  console.log(C.dim(`Copy the full output above and paste it back.`));
}

main().catch((e) => {
  console.error(C.red(C.bold("✗ diagnostic crashed:")), e);
  process.exit(1);
});

import fs from "node:fs";
import path from "node:path";
import type { CropJobMessage } from "../services/pubsub.js";
import { getCachedVideo } from "../services/video-cache.js";
import { cropSegment } from "../services/ffmpeg.js";
import { uploadClip, updateSegmentDoc, getSignedSourceUrl } from "../services/firebase.js";
import { uploadToCloudflareStream } from "../services/cloudflare.js";

/**
 * iPhone-recorded `.mov` files have the `moov` atom written at the END of
 * the file (not faststart). Reading them via HTTP forces ffmpeg to scan
 * for moov by issuing many small range requests, which on droplet-class
 * bandwidth means many minutes of "appears frozen". Skip streaming for
 * these and use the local LRU disk cache instead — that's a single big
 * GET which the droplet handles fine.
 *
 * Faststart .mp4 (everything else we get) streams fine via HTTP range
 * reads and saves the full-file download entirely.
 */
function shouldStreamSource(videoStoragePath: string): boolean {
  const ext = path.extname(videoStoragePath).toLowerCase();
  // Anything .mov: assume non-faststart, skip streaming.
  if (ext === ".mov") return false;
  return true;
}

async function cropWithFallback(
  segmentId: string,
  videoStoragePath: string,
  startSeconds: number,
  endSeconds: number,
): Promise<string> {
  if (shouldStreamSource(videoStoragePath)) {
    try {
      const signedUrl = await getSignedSourceUrl(videoStoragePath);
      return await cropSegment({
        input: signedUrl,
        segmentId,
        startSeconds,
        endSeconds,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[segment ${segmentId}] streaming crop failed (${msg}), falling back to full download`,
      );
    }
  } else {
    console.log(
      `[segment ${segmentId}] skipping HTTP streaming for ${path.extname(videoStoragePath)} ` +
        `(likely non-faststart) — using cached download path`,
    );
  }

  const inputPath = await getCachedVideo(videoStoragePath);
  return cropSegment({
    input: inputPath,
    segmentId,
    startSeconds,
    endSeconds,
  });
}

/**
 * Cloudflare mirror — never fails the job; download is already live via Firebase.
 */
function mirrorToCloudflareInBackground(clipPath: string, segmentId: string): void {
  uploadToCloudflareStream(clipPath, segmentId)
    .then(({ uid }) =>
      updateSegmentDoc(segmentId, {
        clipCloudflareUid: uid,
      }),
    )
    .then(() => console.log(`[segment ${segmentId}] Cloudflare mirror complete`))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[segment ${segmentId}] Cloudflare mirror failed (clip still downloadable via Firebase): ${msg}`,
      );
    })
    .finally(() => {
      if (fs.existsSync(clipPath)) {
        fs.unlinkSync(clipPath);
      }
    });
}

export async function processSegment(job: CropJobMessage): Promise<void> {
  const { segmentId, videoStoragePath, startSeconds, endSeconds } = job;

  console.log(
    `[segment ${segmentId}] processing ${videoStoragePath} [${startSeconds}s–${endSeconds}s]`,
  );

  const clipPath = await cropWithFallback(
    segmentId,
    videoStoragePath,
    startSeconds,
    endSeconds,
  );

  // Priority: Firebase Storage + signed download URL. Editor can download
  // as soon as this completes — we do NOT wait for Cloudflare.
  let downloadUrl: string;
  try {
    downloadUrl = await uploadClip(clipPath, segmentId);
  } catch (err) {
    if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Firebase Storage upload failed: ${reason}`);
  }

  await updateSegmentDoc(segmentId, {
    clipStoragePath: `clips/${segmentId}.mp4`,
    clipDownloadUrl: downloadUrl,
    clipStatus: "ready",
  });

  console.log(
    `[segment ${segmentId}] ready for download (Firebase signed URL) — starting Cloudflare mirror`,
  );

  mirrorToCloudflareInBackground(clipPath, segmentId);
}

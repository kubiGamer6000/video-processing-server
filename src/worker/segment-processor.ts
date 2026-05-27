import fs from "node:fs";
import type { CropJobMessage } from "../services/pubsub.js";
import { getCachedVideo } from "../services/video-cache.js";
import { cropSegment } from "../services/ffmpeg.js";
import { uploadClip, updateSegmentDoc, getSignedSourceUrl } from "../services/firebase.js";
import { uploadToCloudflareStream } from "../services/cloudflare.js";

/**
 * Crop the segment, trying the fast HTTP-streaming path first and falling
 * back to a full download into the LRU cache only when streaming fails (which
 * happens for non-faststart MP4s where the `moov` atom is at the end of the
 * file, since FFmpeg can't range-seek without the index).
 */
async function cropWithFallback(
  segmentId: string,
  videoStoragePath: string,
  startSeconds: number,
  endSeconds: number,
): Promise<string> {
  // Path 1: stream directly from a signed URL — no download, no disk cache.
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

  // Path 2 (fallback): download the whole source into the LRU cache and
  // crop from local disk. Same behavior as the original implementation.
  const inputPath = await getCachedVideo(videoStoragePath);
  return cropSegment({
    input: inputPath,
    segmentId,
    startSeconds,
    endSeconds,
  });
}

export async function processSegment(job: CropJobMessage): Promise<void> {
  const { segmentId, videoStoragePath, startSeconds, endSeconds } = job;

  const clipPath = await cropWithFallback(
    segmentId,
    videoStoragePath,
    startSeconds,
    endSeconds,
  );

  const [storageResult, cfResult] = await Promise.allSettled([
    uploadClip(clipPath, segmentId),
    uploadToCloudflareStream(clipPath, segmentId),
  ]);

  if (fs.existsSync(clipPath)) {
    fs.unlinkSync(clipPath);
  }

  if (storageResult.status === "rejected") {
    const reason = storageResult.reason instanceof Error
      ? storageResult.reason.message
      : JSON.stringify(storageResult.reason);
    throw new Error(`Firebase Storage upload failed: ${reason}`);
  }
  if (cfResult.status === "rejected") {
    const reason = cfResult.reason instanceof Error
      ? cfResult.reason.message
      : JSON.stringify(cfResult.reason);
    throw new Error(`Cloudflare Stream upload failed: ${reason}`);
  }

  await updateSegmentDoc(segmentId, {
    clipStoragePath: `clips/${segmentId}.mp4`,
    clipDownloadUrl: storageResult.value,
    clipCloudflareUid: cfResult.value.uid,
    clipStatus: "processing",
  });

  console.log(`Segment ${segmentId} processed successfully`);
}

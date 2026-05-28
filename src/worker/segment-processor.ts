import fs from "node:fs";
import type { CropJobMessage } from "../services/pubsub.js";
import { getCachedVideo } from "../services/video-cache.js";
import { cropSegment } from "../services/ffmpeg.js";
import { uploadClip, updateSegmentDoc, getSignedSourceUrl } from "../services/firebase.js";
import { uploadToCloudflareStream } from "../services/cloudflare.js";

async function cropWithFallback(
  segmentId: string,
  videoStoragePath: string,
  startSeconds: number,
  endSeconds: number,
): Promise<string> {
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

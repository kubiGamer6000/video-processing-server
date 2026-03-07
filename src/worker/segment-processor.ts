import fs from "node:fs";
import type { CropJobMessage } from "../services/pubsub.js";
import { getCachedVideo } from "../services/video-cache.js";
import { cropSegment } from "../services/ffmpeg.js";
import { uploadClip, updateSegmentDoc } from "../services/firebase.js";
import { uploadToCloudflareStream } from "../services/cloudflare.js";

export async function processSegment(job: CropJobMessage): Promise<void> {
  const { segmentId, videoStoragePath, startSeconds, endSeconds } = job;

  const inputPath = await getCachedVideo(videoStoragePath);

  const clipPath = await cropSegment({
    inputPath,
    segmentId,
    startSeconds,
    endSeconds,
  });

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

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

  try {
    const [clipDownloadUrl, cfResult] = await Promise.all([
      uploadClip(clipPath, segmentId),
      uploadToCloudflareStream(clipPath, segmentId),
    ]);

    await updateSegmentDoc(segmentId, {
      clipStoragePath: `clips/${segmentId}.mp4`,
      clipDownloadUrl,
      clipCloudflareUid: cfResult.uid,
      clipStatus: "ready",
    });

    console.log(`Segment ${segmentId} processed successfully`);
  } finally {
    if (fs.existsSync(clipPath)) {
      fs.unlinkSync(clipPath);
    }
  }
}

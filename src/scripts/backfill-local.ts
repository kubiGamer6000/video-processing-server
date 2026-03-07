import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { initFirebase, getDb, uploadClip, updateSegmentDoc } from "../services/firebase.js";
import { cropSegment } from "../services/ffmpeg.js";
import { uploadToCloudflareStream } from "../services/cloudflare.js";

const LOCAL_VIDEOS_DIR = path.resolve(__dirname, "../../../VideoDataExtractorV1/videos");

interface SegmentDoc {
  videoStoragePath?: string;
  videoFileName?: string;
  startSeconds?: number;
  endSeconds?: number;
}

function resolveLocalVideo(data: SegmentDoc): string | null {
  // Try videoStoragePath first (e.g. "videos/C0624.MP4" -> "C0624.MP4")
  if (data.videoStoragePath) {
    const fileName = path.basename(data.videoStoragePath);
    const fullPath = path.join(LOCAL_VIDEOS_DIR, fileName);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  // Fall back to videoFileName
  if (data.videoFileName) {
    const fullPath = path.join(LOCAL_VIDEOS_DIR, data.videoFileName);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  return null;
}

async function processLocalSegment(
  segmentId: string,
  localVideoPath: string,
  startSeconds: number,
  endSeconds: number,
): Promise<void> {
  const clipPath = await cropSegment({
    inputPath: localVideoPath,
    segmentId,
    startSeconds,
    endSeconds,
  });

  // Use allSettled so both uploads finish before we touch the clip file.
  // Promise.all would reject immediately on first failure, leaving the tus
  // ReadStream still open when the finally block deletes the file → ENOENT crash.
  const [storageResult, cfResult] = await Promise.allSettled([
    uploadClip(clipPath, segmentId),
    uploadToCloudflareStream(clipPath, segmentId),
  ]);

  // Safe to delete now -- both uploads are done or failed
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
}

async function backfillLocal(): Promise<void> {
  getEnv();
  initFirebase();
  const db = getDb();

  if (!fs.existsSync(LOCAL_VIDEOS_DIR)) {
    console.error(`Local videos directory not found: ${LOCAL_VIDEOS_DIR}`);
    process.exit(1);
  }

  const localFiles = fs.readdirSync(LOCAL_VIDEOS_DIR);
  console.log(`Found ${localFiles.length} local video files in ${LOCAL_VIDEOS_DIR}`);

  const forceAll = process.argv.includes("--force");

  console.log(forceAll
    ? "Querying ALL segments (--force: overriding previous results)..."
    : "Querying segments without clips...",
  );
  const allSegments = await db.collection("segments").get();
  const unprocessed = forceAll
    ? allSegments.docs
    : allSegments.docs.filter(
      (doc: FirebaseFirestore.QueryDocumentSnapshot) => !doc.data().clipStatus,
    );

  console.log(`Found ${unprocessed.length} segments to process`);

  // Group by resolved local path for logging
  const groups = new Map<string, Array<{ id: string; start: number; end: number }>>();
  let skippedMissing = 0;
  let skippedFields = 0;

  for (const doc of unprocessed) {
    const data = doc.data() as SegmentDoc;

    if (data.startSeconds == null || data.endSeconds == null) {
      skippedFields++;
      console.warn(`  Skipping ${doc.id}: missing startSeconds or endSeconds`);
      continue;
    }

    const localPath = resolveLocalVideo(data);
    if (!localPath) {
      skippedMissing++;
      const name = data.videoStoragePath || data.videoFileName || "unknown";
      console.warn(`  Skipping ${doc.id}: video not found locally (${name})`);
      continue;
    }

    if (!groups.has(localPath)) groups.set(localPath, []);
    groups.get(localPath)!.push({ id: doc.id, start: data.startSeconds, end: data.endSeconds });
  }

  const totalToProcess = Array.from(groups.values()).reduce((sum, g) => sum + g.length, 0);
  console.log(`\nReady to process: ${totalToProcess} segments from ${groups.size} videos`);
  if (skippedFields > 0) console.log(`Skipped (missing fields): ${skippedFields}`);
  if (skippedMissing > 0) console.log(`Skipped (video not found locally): ${skippedMissing}`);

  let processed = 0;
  let failed = 0;

  for (const [localVideoPath, segments] of groups) {
    const videoName = path.basename(localVideoPath);
    console.log(`\n--- ${videoName} (${segments.length} segments) ---`);

    for (const seg of segments) {
      try {
        await processLocalSegment(seg.id, localVideoPath, seg.start, seg.end);
        processed++;
        console.log(`  [${processed}/${totalToProcess}] ${seg.id} done`);
      } catch (err) {
        failed++;
        console.error(`  FAILED ${seg.id}:`, err);
      }
    }
  }

  console.log(`\nBackfill complete: ${processed} processed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

backfillLocal().catch((err) => {
  console.error("Backfill crashed:", err);
  process.exit(1);
});

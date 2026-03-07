import "dotenv/config";
import { getEnv } from "../config/env.js";
import { initFirebase, getDb } from "../services/firebase.js";
import { processSegment } from "../worker/segment-processor.js";
import { cleanupOldCache } from "../services/video-cache.js";

interface SegmentDoc {
  videoStoragePath?: string;
  startSeconds?: number;
  endSeconds?: number;
}

async function backfill(): Promise<void> {
  getEnv();
  initFirebase();
  const db = getDb();

  console.log("Querying segments without clips...");

  // Firestore can't query for "field does not exist", so fetch all and filter
  const allSegments = await db.collection("segments").get();
  const unprocessed = allSegments.docs.filter(
    (doc: FirebaseFirestore.QueryDocumentSnapshot) => !doc.data().clipStatus,
  );

  console.log(`Found ${unprocessed.length} segments to process`);

  // Group by videoStoragePath so we download each video only once
  const groups = new Map<string, Array<{ id: string; data: SegmentDoc }>>();
  for (const doc of unprocessed) {
    const data = doc.data() as SegmentDoc;
    const vsp = data.videoStoragePath;
    if (!vsp || data.startSeconds == null || data.endSeconds == null) {
      console.warn(`Skipping segment ${doc.id}: missing required fields`);
      continue;
    }
    if (!groups.has(vsp)) groups.set(vsp, []);
    groups.get(vsp)!.push({ id: doc.id, data });
  }

  console.log(`Grouped into ${groups.size} source videos`);

  let processed = 0;
  let failed = 0;

  for (const [videoStoragePath, segments] of groups) {
    console.log(`\nProcessing ${segments.length} segments from: ${videoStoragePath}`);

    for (const seg of segments) {
      try {
        await processSegment({
          segmentId: seg.id,
          videoStoragePath,
          startSeconds: seg.data.startSeconds!,
          endSeconds: seg.data.endSeconds!,
        });
        processed++;
        console.log(`  [${processed}/${unprocessed.length}] ${seg.id} done`);
      } catch (err) {
        failed++;
        console.error(`  FAILED ${seg.id}:`, err);
      }
    }
  }

  cleanupOldCache(0);

  console.log(`\nBackfill complete: ${processed} processed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

backfill().catch((err) => {
  console.error("Backfill crashed:", err);
  process.exit(1);
});

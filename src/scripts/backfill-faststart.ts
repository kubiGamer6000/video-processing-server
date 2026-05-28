/**
 * Bulk backfill: walk every `.mov` video in Firestore and produce a
 * faststart .mp4 sidecar in Firebase Storage. After this completes,
 * every .mov in the library is ready for fast HTTP streaming and
 * no segment crop / transcription ever has to download a full file
 * again.
 *
 * Usage (run on the droplet so we get its bandwidth + ffmpeg):
 *
 *   npx tsx src/scripts/backfill-faststart.ts            # dry-run, lists work
 *   npx tsx src/scripts/backfill-faststart.ts --apply    # actually migrate
 *   npx tsx src/scripts/backfill-faststart.ts --apply --concurrency=2
 *   npx tsx src/scripts/backfill-faststart.ts --apply --only=<storagePath>
 *
 * The script:
 *   - reads all `videos` docs from Firestore
 *   - filters to those where storagePath ends in .mov AND
 *     faststartStoragePath is unset
 *   - for each, downloads the .mov (LRU cached on disk), stream-copy
 *     remuxes to faststart .mp4, uploads to `faststart_cache/`, and
 *     writes back faststartStoragePath
 *   - runs up to N migrations in parallel (default 1 — droplets have
 *     1 vCPU; bumping concurrency just slows everything down)
 *   - dry-run by default so you see what it'll do before committing
 */
// Load .env BEFORE anything reads process.env — otherwise getEnv() bails
// out with "Required" errors because zod sees process.env empty.
import "dotenv/config";
import { getEnv } from "../config/env.js";
import { initFirebase, getDb } from "../services/firebase.js";
import { getCachedVideo } from "../services/video-cache.js";
import { migrateToFaststart } from "../services/faststart.js";

type Args = {
  apply: boolean;
  concurrency: number;
  only: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, concurrency: 1, only: null };
  for (const a of argv) {
    if (a === "--apply") args.apply = true;
    else if (a.startsWith("--concurrency=")) {
      const n = parseInt(a.slice("--concurrency=".length), 10);
      if (n > 0) args.concurrency = n;
    } else if (a.startsWith("--only=")) {
      args.only = a.slice("--only=".length);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log("backfill-faststart args:", args);

  getEnv();
  initFirebase();
  const db = getDb();

  console.log("Reading videos collection...");
  const snap = await db.collection("videos").get();
  const candidates = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((v: Record<string, unknown>) => {
      const sp = v.storagePath as string | undefined;
      if (!sp) return false;
      if (args.only && sp !== args.only) return false;
      if (!sp.toLowerCase().endsWith(".mov")) return false;
      if (v.faststartStoragePath) return false;
      return true;
    });

  console.log(`Found ${candidates.length} .mov videos missing a faststart sidecar.`);
  if (candidates.length === 0) {
    console.log("Nothing to do. Exiting.");
    return;
  }

  for (const v of candidates.slice(0, 20)) {
    console.log(`  - ${(v as Record<string, unknown>).storagePath}`);
  }
  if (candidates.length > 20) {
    console.log(`  ... and ${candidates.length - 20} more`);
  }

  if (!args.apply) {
    console.log(
      "\nDry-run. Re-run with --apply to actually create faststart sidecars.",
    );
    return;
  }

  console.log(
    `\nStarting migrations (concurrency=${args.concurrency})…\n`,
  );

  let done = 0;
  let failed = 0;
  const queue = [...candidates];

  async function worker(workerId: number): Promise<void> {
    while (queue.length > 0) {
      const v = queue.shift();
      if (!v) return;
      const sp = (v as Record<string, unknown>).storagePath as string;
      const idx = candidates.length - queue.length;
      console.log(`\n[w${workerId}] (${idx}/${candidates.length}) ${sp}`);
      try {
        const localPath = await getCachedVideo(sp);
        await migrateToFaststart({
          localMovPath: localPath,
          originalStoragePath: sp,
        });
        done++;
      } catch (err) {
        failed++;
        console.error(
          `[w${workerId}] failed ${sp}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < args.concurrency; i++) {
    workers.push(worker(i + 1));
  }
  await Promise.all(workers);

  console.log(
    `\nDone. ${done} succeeded, ${failed} failed, ${candidates.length - done - failed} skipped.`,
  );
}

main().catch((err) => {
  console.error("backfill-faststart crashed:", err);
  process.exit(1);
});

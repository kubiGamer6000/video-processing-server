import "dotenv/config";
import { getEnv } from "../config/env.js";
import { initFirebase, getDb } from "../services/firebase.js";

const CF_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

async function disableSignedUrls(accountId: string, apiToken: string, uid: string): Promise<boolean> {
  const res = await fetch(`${CF_API_BASE}/${accountId}/stream/${uid}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requireSignedURLs: false }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`  Failed for ${uid}: ${res.status} ${body}`);
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const env = getEnv();
  initFirebase();
  const db = getDb();

  console.log("Querying segments with clipCloudflareUid...");
  const allSegments = await db.collection("segments").get();
  const withClips = allSegments.docs.filter(
    (doc: FirebaseFirestore.QueryDocumentSnapshot) => doc.data().clipCloudflareUid,
  );

  console.log(`Found ${withClips.length} clips to update\n`);

  let fixed = 0;
  let failed = 0;

  for (const doc of withClips) {
    const uid = doc.data().clipCloudflareUid as string;
    const ok = await disableSignedUrls(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, uid);
    if (ok) {
      fixed++;
      if (fixed % 50 === 0) console.log(`  Progress: ${fixed}/${withClips.length}`);
    } else {
      failed++;
    }
  }

  console.log(`\nDone: ${fixed} fixed, ${failed} failed out of ${withClips.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});

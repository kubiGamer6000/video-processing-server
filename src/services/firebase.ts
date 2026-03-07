import fs from "node:fs";
import { initializeApp, cert, type App } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getEnv } from "../config/env.js";

let app: App;
let bucket: ReturnType<ReturnType<typeof getStorage>["bucket"]>;
let db: ReturnType<typeof getFirestore>;

export function initFirebase(): void {
  const env = getEnv();
  app = initializeApp({
    credential: cert(env.GCP_KEY_FILE),
    storageBucket: env.FIREBASE_STORAGE_BUCKET,
  });
  bucket = getStorage(app).bucket();
  db = getFirestore(app);
}

export function getBucket() {
  return bucket;
}

export function getDb() {
  return db;
}

export async function downloadVideo(storagePath: string, destPath: string): Promise<void> {
  const file = bucket.file(storagePath);
  return new Promise<void>((resolve, reject) => {
    const writeStream = fs.createWriteStream(destPath);
    file
      .createReadStream()
      .on("error", (err) => {
        writeStream.destroy();
        fs.unlink(destPath, () => {});
        reject(err);
      })
      .pipe(writeStream)
      .on("finish", resolve)
      .on("error", (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

export async function uploadClip(localPath: string, segmentId: string): Promise<string> {
  const destPath = `clips/${segmentId}.mp4`;
  await bucket.upload(localPath, { destination: destPath });

  const file = bucket.file(destPath);
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: "2030-01-01",
  });
  return url;
}

export interface ClipUpdateData {
  clipStoragePath: string;
  clipDownloadUrl: string;
  clipCloudflareUid: string;
  clipStatus: "processing" | "ready" | "clip_failed";
}

export async function updateSegmentDoc(
  segmentId: string,
  clipData: Partial<ClipUpdateData>,
): Promise<void> {
  await db.collection("segments").doc(segmentId).update({
    ...clipData,
    clipProcessedAt: FieldValue.serverTimestamp(),
  });
}

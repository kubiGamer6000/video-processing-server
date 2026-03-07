import { initializeApp, cert, type App } from "firebase-admin/app";
import { getStorage, type Bucket } from "firebase-admin/storage";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import { getEnv } from "../config/env.js";

let app: App;
let bucket: Bucket;
let db: Firestore;

export function initFirebase(): void {
  const env = getEnv();
  app = initializeApp({
    credential: cert(env.GCP_KEY_FILE),
    storageBucket: env.FIREBASE_STORAGE_BUCKET,
  });
  bucket = getStorage(app).bucket();
  db = getFirestore(app);
}

export function getBucket(): Bucket {
  return bucket;
}

export function getDb(): Firestore {
  return db;
}

export async function downloadVideo(storagePath: string, destPath: string): Promise<void> {
  const file = bucket.file(storagePath);
  await file.download({ destination: destPath });
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
  clipStatus: "ready" | "error";
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

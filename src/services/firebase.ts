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

/**
 * Generates a short-lived (1h) read signed URL for a source video in Firebase
 * Storage. Used to let FFmpeg stream-read from the file over HTTPS (with HTTP
 * range requests) instead of downloading the whole file to disk.
 */
export async function getSignedSourceUrl(storagePath: string): Promise<string> {
  const file = bucket.file(storagePath);
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 60 * 60 * 1000,
  });
  return url;
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

/**
 * Uploads a finished clip to Firebase Storage and returns a long-lived
 * signed download URL. Optimised for "ready ASAP":
 *   - resumable: false for clips <50MB — a single-shot HTTP PUT instead of
 *     the two-step resumable handshake. Cuts ~200-500ms off the typical
 *     short-clip upload.
 *   - explicit content-type + immutable cache-control so browsers and
 *     CDNs can keep the file forever (cropped clips never change once
 *     uploaded; they're addressed by segmentId).
 */
export async function uploadClip(localPath: string, segmentId: string): Promise<string> {
  const destPath = `clips/${segmentId}.mp4`;
  const sizeBytes = fs.statSync(localPath).size;
  const useResumable = sizeBytes > 50 * 1024 * 1024;
  await bucket.upload(localPath, {
    destination: destPath,
    resumable: useResumable,
    metadata: {
      contentType: "video/mp4",
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

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

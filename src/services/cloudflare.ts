import fs from "node:fs";
import * as tus from "tus-js-client";
import { getEnv } from "../config/env.js";

const CF_API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB – Cloudflare recommended for reliable connections

export interface StreamUploadResult {
  uid: string;
}

/**
 * Uploads a local video file to Cloudflare Stream using the tus (resumable) protocol.
 * Handles large clips reliably by uploading in 50 MB chunks with automatic retry.
 */
export function uploadToCloudflareStream(
  localPath: string,
  segmentId: string,
): Promise<StreamUploadResult> {
  const env = getEnv();
  const endpoint = `${CF_API_BASE}/${env.CF_ACCOUNT_ID}/stream`;
  const fileSize = fs.statSync(localPath).size;
  const fileStream = fs.createReadStream(localPath);

  return new Promise<StreamUploadResult>((resolve, reject) => {
    const upload = new tus.Upload(fileStream, {
      endpoint,
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
      chunkSize: CHUNK_SIZE,
      uploadSize: fileSize,
      retryDelays: [1000, 3000, 5000, 10000],
      metadata: {
        name: `clip-${segmentId}.mp4`,
        requiresignedurls: "false",
        segmentId,
      },
      onError(err) {
        reject(new Error(`Cloudflare tus upload failed for ${segmentId}: ${err.message}`));
      },
      onSuccess() {
        const uploadUrl = upload.url;
        if (!uploadUrl) {
          reject(new Error(`Cloudflare tus upload returned no URL for ${segmentId}`));
          return;
        }
        // URL format: https://api.cloudflare.com/.../stream/{uid}?tusv2=true
        const urlPath = new URL(uploadUrl).pathname;
        const uid = urlPath.split("/").pop();
        if (!uid) {
          reject(new Error(`Could not parse UID from upload URL: ${uploadUrl}`));
          return;
        }
        console.log(`Cloudflare Stream upload complete: ${segmentId} → ${uid}`);
        resolve({ uid });
      },
      onProgress(bytesUploaded, bytesTotal) {
        const pct = ((bytesUploaded / bytesTotal) * 100).toFixed(1);
        console.log(`  CF upload ${segmentId}: ${pct}% (${(bytesUploaded / 1024 / 1024).toFixed(1)} MB / ${(bytesTotal / 1024 / 1024).toFixed(1)} MB)`);
      },
    });

    upload.start();
  });
}

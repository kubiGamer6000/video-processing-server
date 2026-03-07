import fs from "node:fs";
import { getEnv } from "../config/env.js";

const CF_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

interface StreamUploadResult {
  uid: string;
}

interface CloudflareApiResponse {
  success: boolean;
  result: { uid: string };
  errors: Array<{ code: number; message: string }>;
}

/**
 * Uploads a local video file to Cloudflare Stream using form-based upload.
 * Suitable for small clips (under 200 MB).
 */
export async function uploadToCloudflareStream(
  localPath: string,
  segmentId: string,
): Promise<StreamUploadResult> {
  const env = getEnv();
  const url = `${CF_API_BASE}/${env.CF_ACCOUNT_ID}/stream`;

  const fileBuffer = fs.readFileSync(localPath);
  const blob = new Blob([fileBuffer]);

  const form = new FormData();
  form.append("file", blob, `${segmentId}.mp4`);
  form.append(
    "meta",
    JSON.stringify({ name: `clip-${segmentId}`, segmentId }),
  );

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
    },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cloudflare Stream upload failed (${res.status}): ${body}`);
  }

  const data: CloudflareApiResponse = await res.json();
  if (!data.success || !data.result?.uid) {
    throw new Error(
      `Cloudflare Stream upload returned no UID: ${JSON.stringify(data.errors)}`,
    );
  }

  return { uid: data.result.uid };
}

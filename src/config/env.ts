import { z } from "zod";

const envSchema = z.object({
  GCP_PROJECT_ID: z.string().min(1),
  GCP_KEY_FILE: z.string().min(1),
  PUBSUB_SUBSCRIPTION: z.string().default("segment-crop-worker"),
  FIREBASE_STORAGE_BUCKET: z.string().min(1),
  CF_ACCOUNT_ID: z.string().min(1),
  CF_API_TOKEN: z.string().min(1),
  VIDEO_CACHE_DIR: z.string().default("/tmp/video-cache"),
  CLIP_OUTPUT_DIR: z.string().default("/tmp/clips"),
  DEPLOY_SECRET: z.string().default(""),
  PORT: z.coerce.number().default(3000),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error("Invalid environment variables:", result.error.flatten().fieldErrors);
      process.exit(1);
    }
    _env = result.data;
  }
  return _env;
}

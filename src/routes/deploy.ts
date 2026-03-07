import { Router } from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { getEnv } from "../config/env.js";

const router = Router();
const DEPLOY_LOG = "/var/log/segment-worker-deploy.log";

function verifySignature(secret: string, payload: string, signature: string): boolean {
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

router.post("/deploy", (req, res) => {
  const env = getEnv();

  if (!env.DEPLOY_SECRET) {
    res.status(403).json({ error: "Deploy webhook not configured" });
    return;
  }

  const signature = req.headers["x-hub-signature-256"] as string;
  if (!signature || !verifySignature(env.DEPLOY_SECRET, JSON.stringify(req.body), signature)) {
    console.log(`[deploy] Rejected: invalid signature`);
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const event = req.headers["x-github-event"];
  const delivery = req.headers["x-github-delivery"] ?? "unknown";
  if (event !== "push") {
    console.log(`[deploy] Ignored event: ${event} (delivery: ${delivery})`);
    res.json({ message: `Ignored event: ${event}` });
    return;
  }

  const ref = req.body?.ref ?? "unknown";
  const pusher = req.body?.pusher?.name ?? "unknown";
  const commitMsg = req.body?.head_commit?.message?.split("\n")[0] ?? "";
  console.log(`[deploy] Push received — ref=${ref}, pusher=${pusher}, commit="${commitMsg}", delivery=${delivery}`);
  res.json({ message: "Deploy started" });

  exec("bash deploy.sh", { cwd: process.cwd() }, (err, _stdout, stderr) => {
    if (err) {
      console.error(`[deploy] FAILED (delivery: ${delivery}):`, stderr);
      return;
    }
    console.log(`[deploy] SUCCESS (delivery: ${delivery})`);
  });
});

router.get("/deploy/log", (_req, res) => {
  if (!fs.existsSync(DEPLOY_LOG)) {
    res.type("text").send("No deploy log found yet.");
    return;
  }

  const content = fs.readFileSync(DEPLOY_LOG, "utf-8");
  const lines = content.trim().split("\n");
  const tail = lines.slice(-100).join("\n");
  res.type("text").send(tail);
});

export default router;

import { Router } from "express";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { getEnv } from "../config/env.js";

const router = Router();

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
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const event = req.headers["x-github-event"];
  if (event !== "push") {
    res.json({ message: `Ignored event: ${event}` });
    return;
  }

  console.log("Deploy webhook received, starting update...");
  res.json({ message: "Deploy started" });

  exec("bash deploy.sh", { cwd: process.cwd() }, (err, stdout, stderr) => {
    if (err) {
      console.error("Deploy failed:", stderr);
      return;
    }
    console.log("Deploy output:", stdout);
  });
});

export default router;

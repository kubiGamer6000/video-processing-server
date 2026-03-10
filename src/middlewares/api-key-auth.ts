import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { getEnv } from "../config/env.js";

/**
 * Express middleware that validates a Bearer token against VPS_API_KEY.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  const token = header.slice(7);
  const expected = getEnv().VPS_API_KEY;

  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);

  if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  next();
}

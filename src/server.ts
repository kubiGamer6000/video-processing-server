import "dotenv/config";
import { getEnv } from "./config/env.js";
import { initFirebase } from "./services/firebase.js";
import { startSubscriber, stopSubscriber } from "./services/pubsub.js";
import { logCacheStats } from "./services/video-cache.js";
import app from "./app.js";

const env = getEnv();

initFirebase();
logCacheStats();
startSubscriber();

// Bind explicitly to 0.0.0.0 so the HTTP server is reachable from outside
// the droplet. (Node defaults to binding all interfaces too, but being
// explicit means a misconfigured HOST env var can't sneak us onto
// 127.0.0.1 and produce the exact ECONNREFUSED we keep hitting.)
const HOST = process.env.HOST || "0.0.0.0";

const server = app.listen(env.PORT, HOST, () => {
  const addr = server.address();
  const addrStr =
    typeof addr === "string" ? addr : addr ? `${addr.address}:${addr.port}` : "?";
  console.log(`Video processing server LISTENING on ${addrStr}`);
  console.log(
    `[startup] HTTP server is up — transcription endpoint reachable. ` +
      `To verify externally: curl http://<droplet-ip>:${env.PORT}/health`,
  );
});

// Crash loudly if app.listen fails (EADDRINUSE, EACCES, etc) — otherwise
// the process can stay alive running only the Pub/Sub subscriber, which
// is the symptom we just hit (crop jobs work, transcribe gives
// ECONNREFUSED). pm2 will restart us; logs will show the real error.
server.on("error", (err) => {
  console.error(`[startup] FATAL: HTTP server failed to bind on ${HOST}:${env.PORT}`, err);
  process.exit(1);
});

function shutdown(): void {
  console.log("Shutting down...");
  stopSubscriber();
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// uncaughtException = sync error that wasn't caught anywhere. The
// process is in an undefined state; safest to die loudly and let pm2
// restart. (Better an obvious restart loop than a running-but-broken
// worker that won't answer HTTP.)
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
  process.exit(1);
});

// unhandledRejection = a promise rejected with no .catch(). Don't kill
// the process — for fire-and-forget calls like migrateToFaststart, an
// occasional rejection is non-fatal. Just log very loudly so we notice.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandled-rejection]", reason);
});

import "dotenv/config";
import { getEnv } from "./config/env.js";
import { initFirebase } from "./services/firebase.js";
import { startSubscriber, stopSubscriber } from "./services/pubsub.js";
import app from "./app.js";

const env = getEnv();

initFirebase();
startSubscriber();

const server = app.listen(env.PORT, () => {
  console.log(`Video processing server running on port ${env.PORT}`);
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

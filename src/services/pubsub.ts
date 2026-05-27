import { PubSub, type Message } from "@google-cloud/pubsub";
import { getEnv } from "../config/env.js";
import { processSegment } from "../worker/segment-processor.js";

let subscription: ReturnType<InstanceType<typeof PubSub>["subscription"]>;

export interface CropJobMessage {
  segmentId: string;
  videoStoragePath: string;
  startSeconds: number;
  endSeconds: number;
}

async function handleMessage(message: Message): Promise<void> {
  let data: CropJobMessage;
  try {
    data = JSON.parse(message.data.toString());
  } catch {
    console.error("Invalid message JSON, acking to discard:", message.data.toString());
    message.ack();
    return;
  }

  console.log(`Received crop job: segment=${data.segmentId}`);

  try {
    await processSegment(data);
    message.ack();
    console.log(`Completed crop job: segment=${data.segmentId}`);
  } catch (err) {
    console.error(`Failed crop job: segment=${data.segmentId}`, err);
    message.nack();
  }
}

export function startSubscriber(): void {
  const env = getEnv();
  const pubsub = new PubSub({
    projectId: env.GCP_PROJECT_ID,
    keyFilename: env.GCP_KEY_FILE,
  });

  subscription = pubsub.subscription(env.PUBSUB_SUBSCRIPTION, {
    flowControl: {
      // With HTTP-streaming crops the bottleneck shifts from disk I/O to
      // network + small bursts of CPU, so we can comfortably run a lot more
      // jobs in parallel than the old disk-thrash-bound limit of 2.
      maxMessages: 8,
    },
  });

  subscription.on("message", (message: Message) => {
    handleMessage(message).catch((err) => {
      console.error("Unhandled error in message handler:", err);
    });
  });

  subscription.on("error", (err) => {
    console.error("Pub/Sub subscription error:", err);
  });

  console.log(`Listening for messages on subscription: ${env.PUBSUB_SUBSCRIPTION}`);
}

export function stopSubscriber(): void {
  if (subscription) {
    subscription.close();
    console.log("Pub/Sub subscriber stopped");
  }
}

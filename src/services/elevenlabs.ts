import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import fs from "node:fs";
import { getEnv } from "../config/env.js";

let client: ElevenLabsClient | null = null;

function getClient(): ElevenLabsClient {
  if (!client) {
    client = new ElevenLabsClient({ apiKey: getEnv().ELEVENLABS_API_KEY });
  }
  return client;
}

/**
 * Sends an audio file to ElevenLabs Scribe v2 for transcription.
 * Returns the full transcription text.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const audioBlob = new Blob([buffer], { type: "audio/mp3" });

  console.log(`ElevenLabs transcribe: ${filePath} (${(buffer.length / 1024).toFixed(0)} KB)`);

  const result = await getClient().speechToText.convert({
    file: audioBlob,
    modelId: "scribe_v2",
    tagAudioEvents: true,
    languageCode: "eng",
  });

  console.log(`ElevenLabs transcription complete: ${result.text.length} chars`);
  return result.text;
}

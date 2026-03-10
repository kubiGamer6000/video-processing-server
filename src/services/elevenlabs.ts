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

export interface TranscriptionWord {
  text: string;
  start: number;
  end: number;
  type: string;
  speaker_id?: string;
}

export interface FullTranscriptionResult {
  text: string;
  words: TranscriptionWord[];
  languageCode: string;
}

/**
 * Transcribes an audio file with word-level timestamps and optional diarization.
 * Returns the full result including the words array for downstream phrase grouping.
 */
export async function transcribeAudioFull(
  filePath: string,
  diarize: boolean,
): Promise<FullTranscriptionResult> {
  const buffer = fs.readFileSync(filePath);
  const ext = filePath.endsWith(".ogg") ? "audio/ogg" : "audio/mp3";
  const audioBlob = new Blob([buffer], { type: ext });

  console.log(
    `ElevenLabs transcribe-full: ${filePath} (${(buffer.length / 1024).toFixed(0)} KB, diarize=${diarize})`,
  );

  const result = await getClient().speechToText.convert({
    file: audioBlob,
    modelId: "scribe_v2",
    tagAudioEvents: true,
    languageCode: "eng",
    diarize,
  });

  const words: TranscriptionWord[] = (result.words ?? [])
    .filter((w) => w.start != null && w.end != null)
    .map((w) => ({
      text: w.text,
      start: w.start!,
      end: w.end!,
      type: w.type,
      speaker_id: (w as unknown as Record<string, unknown>).speaker_id as string | undefined,
    }));

  console.log(
    `ElevenLabs transcribe-full complete: ${result.text.length} chars, ${words.length} words`,
  );

  return {
    text: result.text,
    words,
    languageCode: (result as unknown as Record<string, unknown>).language_code as string ?? "eng",
  };
}

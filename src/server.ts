import { Porcupine, BuiltinKeyword } from "@picovoice/porcupine-node";
import { PvRecorder } from "@picovoice/pvrecorder-node";
import * as dotenv from "dotenv";
import OpenAI from 'openai';
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { config } from "dotenv";

config();

dotenv.config();

const FRAME_LENGTH = 512;
const DEVICE_INDEX = 3;           
const SENSITIVITY = 0.5;
const REFRACTORY_MS = 750;         
const KEYWORD = BuiltinKeyword.COMPUTER;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY");
const ALSA_DEVICE = process.env.ALSA_DEVICE || "plughw:3,0";
const SAMPLE_RATE = 16000;              
const MIN_COMMIT_MS = 200;         

function msFromPcmBytes(bytes: number, sr = SAMPLE_RATE) {
  const samples = bytes / 2;            // 16-bit mono
  return (samples / sr) * 1000;
}
export async function start() {
  const ACCESS_KEY = process.env.PICOVOICE_ACCESS_KEY;
  if (!ACCESS_KEY) throw new Error("PICOVOICE_ACCESS_KEY not set in environment");


  let porcupine: Porcupine | null = null;
  let recorder: PvRecorder | null = null;
  let shuttingDown = false;
  let lastDetect = 0;

  // graceful shutdown
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (recorder) {
        try { recorder.stop(); } catch {}
        try { recorder.release(); } catch {}
      }
      if (porcupine) {
        try { porcupine.release(); } catch {}
      }
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    console.log("🚀 Initializing Porcupine…");
    porcupine = new Porcupine(ACCESS_KEY, [KEYWORD], [SENSITIVITY]);

    console.log("🎙️ Creating recorder…");
    recorder = new PvRecorder(FRAME_LENGTH, DEVICE_INDEX);
    await recorder.start();
    console.log("👂 Listening for wake word 'Computer'…");

    while (recorder.isRecording) {
      const frame = await recorder.read();        
      const idx = porcupine.process(frame);
if (idx >= 0) {
  const now = Date.now();
  if (now - lastDetect < REFRACTORY_MS) continue;
  lastDetect = now;

  console.log("🔵 Wake word detected!");
  recorder = await pauseAndHandle(recorder, porcupine); // ← get the new instance
}
    }
  } catch (err) {
    console.error("❌ Error:", err);
    throw err;
  } finally {
    await shutdown();
  }
}

async function pauseAndHandle(rec: PvRecorder, porcupine: Porcupine): Promise<PvRecorder> {
  try {
    try { rec.stop(); } catch {}
    try { rec.release(); } catch {}

    const transcript = await handleSpeech();
    if (transcript) {
      console.log("💬 Processing:", transcript);
      await handleTranscript(transcript);
    }
  } catch (e) {
    console.error("❌ handle error:", e);
  } finally {
    // recreate recorder for wake loop
    const newRec = new PvRecorder(FRAME_LENGTH, DEVICE_INDEX);
    await newRec.start();
    console.log("🔁 Back to wake-word listening…");
    return newRec;
  }
}

async function handleTranscript(transcript: string) {
  // This is where you'd:
  // 1. Send transcript to GPT for response
  // 2. Get response
  // 3. Convert to speech with TTS
  // 4. Play audio response
  console.log("🤖 Would process:", transcript);
  // For now, just a placeholder
  await sleep(100);
}


function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function handleSpeech(): Promise<string> {


  return new Promise((resolve, reject) => {
     const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    let arecord: any = null;
    let audioMsSent = 0;
    let transcriptionReceived = false;

    const stopMic = () => {
      if (arecord) {
        try { 
          arecord.kill("SIGTERM"); 
          arecord = null;
        } catch {}
      }
    };

    const cleanup = () => {
      stopMic();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };

    // Set a timeout to prevent hanging forever
    const timeout = setTimeout(() => {
      if (!transcriptionReceived) {
        console.warn("⏱️ Transcription timeout");
        cleanup();
        resolve("");
      }
    }, 15000); // 15 second timeout

    ws.on("open", () => {
      console.log("🌐 Realtime connected");
      
      // Configure session for transcription with server VAD
      const sessionUpdate = {
        type: "session.update",
        session: {
          modalities: ["text"],
          instructions: "Transcribe the audio.",
          input_audio_format: "pcm16",
          input_audio_transcription: {
            model: "whisper-1"
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
          }
        },
      };
      ws.send(JSON.stringify(sessionUpdate));
    });

    ws.on("message", async (raw) => {
      const evt = JSON.parse(raw.toString());
      const t = evt.type as string;

      switch (t) {
        case "session.updated":
          console.log("✅ Session configured, starting audio capture...");
          
          // Start audio capture AFTER session is configured
          arecord = spawn("arecord", [
            "-D", ALSA_DEVICE,
            "-f", "S16_LE",
            "-r", String(SAMPLE_RATE),
            "-c", "1",
            "-t", "raw",
          ]);

          console.log("🎤 Recording... speak now!");

          arecord.stdout.on("data", (chunk: Buffer) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            audioMsSent += msFromPcmBytes(chunk.length);
            
            // Send audio to OpenAI
            ws.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: chunk.toString("base64"),
              })
            );
          });

          arecord.stderr.on("data", (d: Buffer) => {
            const msg = d.toString();
            if (msg.includes("error")) {
              console.error("arecord error:", msg);
            }
          });

          arecord.on("close", (code: number) => {
            if (code !== 0 && code !== null) {
              console.warn("arecord exited with code:", code);
            }
          });

          arecord.on("error", (err: Error) => {
            console.error("arecord spawn error:", err);
            reject(err);
          });
          break;

        case "input_audio_buffer.speech_started":
          console.log("🗣️ Speech detected by server");
          break;

        case "input_audio_buffer.speech_stopped":
          console.log("🔇 Speech stopped, committing buffer");
          stopMic();
          
          if (audioMsSent >= MIN_COMMIT_MS) {
            ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          } else {
            console.log("⚠️ Audio too short, not committing");
            cleanup();
            clearTimeout(timeout);
            resolve("");
          }
          break;

        case "input_audio_buffer.committed":
          console.log("📦 Buffer committed, waiting for transcription...");
          break;

        case "conversation.item.input_audio_transcription.completed":
        case "input_audio_transcription.completed":
        case "transcription.final": {
          const finalText = evt.transcript || evt.text || "";
          console.log("📝 Transcription:", JSON.stringify(finalText));
          
          transcriptionReceived = true;
          clearTimeout(timeout);
          cleanup();
          resolve(finalText);
          break;
        }

        case "conversation.item.created":
          // This often comes before transcription
          const item = evt.item || {};
          if (item.type === "message" && item.role === "user") {
            console.log("💭 Processing transcription...");
          }
          break;

        case "error":
          console.error("❌ Realtime error:", evt.error);
          clearTimeout(timeout);
          cleanup();
          reject(new Error(evt.error?.message || "Unknown error"));
          break;

        default:
          // Uncomment to debug all events
          // console.log("Event:", t);
          break;
      }
    });

    ws.on("close", () => {
      console.log("🔌 WebSocket closed");
      if (!transcriptionReceived) {
        clearTimeout(timeout);
        resolve("");
      }
    });

    ws.on("error", (e) => {
      console.error("❌ WebSocket error:", e);
      clearTimeout(timeout);
      cleanup();
      reject(e);
    });
  });
}

// run if invoked directly
if (require.main === module) {
  start().catch((e) => {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  });
}
import { Porcupine, BuiltinKeyword } from "@picovoice/porcupine-node";
import { PvRecorder } from "@picovoice/pvrecorder-node";
import WebSocket from "ws";
import { config } from "dotenv";
import { answerAndSpeakRealtime } from "./speak";
import { msFromPcmBytes, sleep } from "./utils";

config();

const FRAME_LENGTH = 512;
const DEVICE_INDEX = 3;
const SENSITIVITY = 0.5;
const REFRACTORY_MS = 750; //prevents the wake word from being called multiple times
const KEYWORD = BuiltinKeyword.COMPUTER;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY");
const SAMPLE_RATE = 16000;

enum Mode { Wake, Converse }

export async function start() {
    const ACCESS_KEY = process.env.PICOVOICE_ACCESS_KEY;
    if (!ACCESS_KEY) throw new Error("PICOVOICE_ACCESS_KEY not set in environment");


    let porcupine: Porcupine | null = null;
    let recorder: PvRecorder | null = null;
    let shuttingDown = false;
    let lastDetect = 0;


    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        try {
            if (recorder) {
                try { recorder.stop(); } catch { }
                try { recorder.release(); } catch { }
            }
            if (porcupine) {
                try { porcupine.release(); } catch { }
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
                recorder = await pauseAndHandle(recorder);
            }
        }
    } catch (err) {
        console.error("❌ Error:", err);
        throw err;
    } finally {
        await shutdown();
    }
}

// this uses the same recorder as the wake word 
async function pauseAndHandle(rec: PvRecorder): Promise<PvRecorder> {
    try {
        const transcript = await handleSpeechWithPvRecorder(rec);

        if (transcript) {
            console.log("💬 Processing:", transcript);
            await handleTranscript(transcript);
        }
    } catch (e) {
        console.error("❌ handle error:", e);
    }

    console.log("🔁 Back to wake-word listening…");
    return rec; // Return the same recorder instance
}

async function handleSpeechWithPvRecorder(recorder: PvRecorder): Promise<string> {

    let shuttingDown = false;

    return new Promise((resolve, reject) => {
        const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

        const ws = new WebSocket(url, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1",
            },
        });

        let audioMsSent = 0;
        let transcriptionReceived = false;
        let isCapturingForSpeech = false;

        const cleanup = () => {
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
        }, 15000);

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
                    console.log("✅ Session configured, starting speech capture...");
                    console.log("🎤 Recording... speak now!");
                    isCapturingForSpeech = true;
                    break;

                case "input_audio_buffer.speech_started":
                    console.log("🗣️ Speech detected by server");
                    break;

                case "input_audio_buffer.speech_stopped":
                    console.log("🔇 Speech stopped, committing buffer");
                    isCapturingForSpeech = false;
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

        // Start the audio capture loop
        const captureLoop = async () => {
            while (!transcriptionReceived && !shuttingDown) {
                try {
                    if (isCapturingForSpeech && recorder && recorder.isRecording) {
                        const frame = await recorder.read();

                        if (ws.readyState === WebSocket.OPEN) {
                            // Convert Int16Array to Buffer for base64 encoding
                            const buffer = Buffer.from(frame.buffer);
                            audioMsSent += msFromPcmBytes(buffer.length, SAMPLE_RATE);

                            ws.send(JSON.stringify({
                                type: "input_audio_buffer.append",
                                audio: buffer.toString("base64"),
                            }));
                        }
                    } else {
                        // Small delay when not actively capturing speech
                        await sleep(10);
                    }
                } catch (e) {
                    console.error("❌ Capture loop error:", e);
                    break;
                }
            }
        };

        // Start the capture loop
        captureLoop();
    });
}

async function handleTranscript(transcript: string) {
    console.log("🤖 Would process:", transcript);

    await answerAndSpeakRealtime(transcript, OPENAI_API_KEY);
}



if (require.main === module) {
    start().catch((e) => {
        console.error("❌ Startup failed:", e);
        process.exit(1);
    });
}
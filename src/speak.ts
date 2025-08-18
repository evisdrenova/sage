// this file handles streaming the voice frames from the LLM server to the client

import WebSocket from "ws";
import { spawn } from "node:child_process";
import { config } from "dotenv";
import { PvRecorder } from "@picovoice/pvrecorder-node";
import { msFromPcmBytes } from "./utils";

config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY");
const SAMPLE_RATE = 16000;
const REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17";
const ALSA_DEVICE = "plughw:4,0"
const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

// raw PCM16 at 24 kHz mono so we can pipe to aplay
const OUT_SAMPLE_RATE = 24000;

export async function answerAndSpeakRealtime(transcript: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const url = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;
        const ws = new WebSocket(url, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1",
            },
        });

        let aplay: ReturnType<typeof spawn> | null = null;
        let startedAudio = false;
        let audioStreamComplete = false;
        let aplayFinished = false;

        const checkComplete = () => {
            if (audioStreamComplete && aplayFinished) {
                console.log("✅ Audio playback complete");
                resolve();
            }
        };

        const openAplay = () => {
            if (aplay) return;

            console.log("🎵 Starting audio playback...");

            aplay = spawn("aplay", [
                "-q",
                "-D", ALSA_DEVICE,
                "-f", "S16_LE",
                "-c", "1",
                "-r", String(OUT_SAMPLE_RATE),
                "-t", "raw",
            ], {
                stdio: ['pipe', 'ignore', 'ignore']
            });

            aplay.on("close", (code) => {
                console.log(`🎵 aplay finished (code: ${code})`);
                aplayFinished = true;
                checkComplete();
            });

            aplay.on("error", (err) => {
                console.error("aplay error:", err);
                aplayFinished = true;
                safeClose();
                reject(err);
            });
        };

        const safeClose = () => {
            try { if (aplay?.stdin && !aplay.stdin.destroyed) aplay.stdin.end(); } catch { }
            try { if (aplay && aplay.pid) aplay.kill("SIGINT"); } catch { }
            try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch { }
        };

        ws.on("open", () => {
            ws.send(JSON.stringify({
                type: "session.update",
                session: {
                    modalities: ["audio", "text"],
                    output_audio_format: "pcm16",
                    voice: "alloy",
                },
            }));

            ws.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: transcript }],
                },
            }));

            ws.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["audio", "text"],
                    instructions: "Answer concisely for spoken playback. Keep the answer to less than 2 sentences.",
                    output_audio_format: "pcm16",
                    voice: "alloy"
                },
            }));
        });

        ws.on("message", (raw) => {
            const evt = JSON.parse(raw.toString());
            const t = evt.type as string;

            switch (t) {
                case "response.audio.delta": {
                    if (!startedAudio) {
                        openAplay();
                        startedAudio = true;
                    }
                    const b64 = evt.delta as string;
                    const buf = Buffer.from(b64, "base64");

                    if (aplay?.stdin?.writable) aplay.stdin.write(buf);
                    break;
                }

                case "response.completed":
                case "response.audio.done": {
                    console.log("🎵 Audio stream complete");
                    audioStreamComplete = true;

                    if (aplay?.stdin?.writable) {
                        aplay.stdin.end();
                    }

                    checkComplete();
                    break;
                }

                case "error": {
                    console.error("Realtime error:", evt.error);
                    safeClose();
                    reject(new Error(evt.error?.message || "Realtime error"));
                    break;
                }
            }
        });

        ws.on("close", () => {
            if (!startedAudio) {
                resolve();
            }
        });

        ws.on("error", (e) => {
            safeClose();
            reject(e);
        });

        setTimeout(() => {
            if (!audioStreamComplete || !aplayFinished) {
                console.warn("⚠️ Audio timeout");
                safeClose();
                resolve();
            }
        }, 30000);
    });
}

export async function transcribeOnceFromRecorder(
    recorder: PvRecorder,
    isPlayingAudio: boolean,
    {
        vadThreshold = 0.5,
        silenceMs = 600,
        maxOverallMs = 20000,
    }: { vadThreshold?: number; silenceMs?: number; maxOverallMs?: number } = {}
): Promise<string> {
    return new Promise((resolve, reject) => {

        if (isPlayingAudio) {
            console.log("🔇 Audio is playing, not transcribing");
            return "";
        }


        const ws = new WebSocket(url, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1",
            },
        });

        let isCapturingSpeech = false;
        let transcriptDone = false;
        let audioMsSent = 0;
        let captureLoopRunning = false;


        const overallTO = setTimeout(() => {
            if (!transcriptDone) {
                try { ws.close(); } catch { }
                resolve(""); // idle
            }
        }, maxOverallMs);

        const cleanup = () => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        }


        const captureLoop = async () => {
            console.log("🎤 Starting capture loop...");
            captureLoopRunning = true;

            try {
                while (!transcriptDone && recorder && recorder.isRecording && ws.readyState === WebSocket.OPEN) {
                    if (isCapturingSpeech) {
                        const frame = await recorder.read(); // 512 samples @ 16 kHz
                        const buffer = Buffer.from(frame.buffer);
                        audioMsSent += msFromPcmBytes(buffer.length, SAMPLE_RATE);

                        ws.send(JSON.stringify({
                            type: "input_audio_buffer.append",
                            audio: buffer.toString("base64"),
                        }));
                    } else {
                        // Small delay when not actively capturing to avoid tight loop
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                }
            } catch (error) {
                console.error("❌ Capture loop error:", error);
            } finally {
                captureLoopRunning = false;
                console.log("🛑 Capture loop ended");
            }
        }


        ws.on("open", () => {

            console.log("🌐 Realtime connected");

            ws.send(JSON.stringify({
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
                        threshold: vadThreshold,
                        prefix_padding_ms: 300,
                        silence_duration_ms: silenceMs,
                    }
                },
            }));
        });

        console.log("web socket ready?", ws.readyState === WebSocket.OPEN)


        // handle server events
        ws.on("message", async (raw) => {
            const evt = JSON.parse(raw.toString());
            const t = evt.type as string;
            switch (t) {
                case "session.updated": {
                    // Start pushing frames right away
                    isCapturingSpeech = true;

                    // Start the capture loop ONLY after session is ready
                    if (!captureLoopRunning) {
                        captureLoop();
                    }
                    break;
                }

                case "input_audio_buffer.speech_started":
                    console.log("🗣️ Speech detected by server");
                    break;

                case "input_audio_buffer.speech_stopped":
                    // Stop sending and finalize this utterance
                    console.log("speech stopped event sent")
                    isCapturingSpeech = false;
                    // ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
                    break;

                case "input_audio_buffer.committed":
                    console.log("📦 Buffer committed, waiting for transcription...");
                    break;

                case "conversation.item.input_audio_transcription.completed":
                case "input_audio_transcription.completed":
                case "transcription.final": {
                    const finalText = evt.transcript || evt.text || "";
                    transcriptDone = true;
                    clearTimeout(overallTO);
                    console.log("📝 Transcription:", JSON.stringify(finalText));
                    cleanup();
                    resolve((finalText || "").trim());
                    break;
                }

                case "conversation.item.created":
                    const item = evt.item || {};
                    if (item.type === "message" && item.role === "user") {
                        console.log("💭 Processing transcription...");
                    }
                    break;

                case "error": {
                    clearTimeout(overallTO);
                    try { ws.close(); } catch { }
                    // Treat empty commit as “no speech”
                    if (evt?.error?.code === "input_audio_buffer_commit_empty") {
                        resolve("");
                    } else {
                        reject(new Error(evt?.error?.message || "Realtime error"));
                    }
                    break;
                }

                default:
                    break;
            }
        });

        ws.on("close", () => {
            clearTimeout(overallTO);
            if (!transcriptDone) {
                clearTimeout(overallTO);
                resolve("");
            }
        });

        ws.on("error", (e) => {
            clearTimeout(overallTO);
            reject(e);
        });

    });
}

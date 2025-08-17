//this streams the vopice frames from the server to the client

import * as dotenv from "dotenv";
import WebSocket from "ws";
import { spawn } from "node:child_process";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY");


const REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17";
const ALSA_DEVICE = "plughw:4,0"

// We’ll request raw PCM16 at 24 kHz mono so we can pipe to aplay.
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

        const openAplay = () => {
            if (aplay) return;
            aplay = spawn("aplay", [
                "-q",
                "-D", ALSA_DEVICE,
                "-f", "S16_LE",
                "-c", "1",
                "-r", String(OUT_SAMPLE_RATE),
                "-t", "raw",
            ]);
            aplay.on("close", (code) => {
                if (code && code !== 0) {
                    console.warn("aplay exited with code:", code);
                }
            });
            aplay.on("error", (err) => {
                console.error("aplay error:", err);
                safeClose();
                reject(err);
            });
        };

        const safeClose = () => {
            try { if (aplay?.stdin && !aplay.stdin.destroyed) aplay.stdin.end(); } catch { }
            try { if (aplay && aplay.pid) aplay.kill("SIGTERM"); } catch { }
            try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch { }
        };

        ws.on("open", () => {
            // 1) Configure the session (optional—can also set per response)
            ws.send(JSON.stringify({
                type: "session.update",
                session: {
                    modalities: ["audio", "text"],
                    // default output format for this connection
                    output_audio_format: "pcm16",
                    // default voice for this connection
                    voice: "alloy",
                },
            }));

            // 2) Add the user's message
            ws.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: transcript }],
                },
            }));

            // 3) Ask the model to respond with audio (override session defaults if you want)
            ws.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["audio", "text"],
                    instructions: "Answer concisely for spoken playback. Keep the answer to less than 2 sentences.",
                    // ✅ audio config belongs here, not as response.audio
                    output_audio_format: "pcm16",
                    voice: "alloy"
                },
            }));
        });

        ws.on("message", (raw) => {
            const evt = JSON.parse(raw.toString());
            const t = evt.type as string;

            console.log("the t", t)
            switch (t) {
                // Streamed PCM16 audio chunks (base64). Write to aplay stdin.
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

                // Optional textual deltas if you want to log partial text:
                case "response.output_text.delta": {
                    console.log(evt.delta);
                    break;
                }

                // Signals the model finished speaking; close audio & socket.
                case "response.completed":
                case "response.audio.done": {
                    if (aplay?.stdin?.writable) aplay.stdin.end();
                    resolve();
                    break;
                }

                case "error": {
                    console.error("Realtime error:", evt.error);
                    safeClose();
                    reject(new Error(evt.error?.message || "Realtime error"));
                    break;
                }

                default:
                    // Uncomment to inspect all events:
                    // console.log("evt:", t);
                    break;
            }
        });

        ws.on("close", () => {
            // If we never got audio, still resolve so your app can continue.
            if (!startedAudio) resolve();
        });

        ws.on("error", (e) => {
            safeClose();
            reject(e);
        });
    });
}

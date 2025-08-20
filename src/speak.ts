import WebSocket from "ws";
import { spawn } from "node:child_process";
import { config } from "dotenv";
import { PvRecorder } from "@picovoice/pvrecorder-node";
import { msFromPcmBytes } from "./utils";
import { runWeatherTool, weatherToolSchema } from "./tools";

config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY");

const SAMPLE_RATE = 16000;
const ALSA_DEVICE = "plughw:4,0"
const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
const OUT_SAMPLE_RATE = 24000;

// export async function speak(transcript: string): Promise<void> {
//     return new Promise<void>((resolve, reject) => {
//         const ws = new WebSocket(url, {
//             headers: {
//                 Authorization: `Bearer ${OPENAI_API_KEY}`,
//                 "OpenAI-Beta": "realtime=v1",
//             },
//         });

//         let aplay: ReturnType<typeof spawn> | null = null;
//         let startedAudio = false;
//         let audioStreamComplete = false;
//         let aplayFinished = false;

//         const checkComplete = () => {
//             if (audioStreamComplete && aplayFinished) {
//                 console.log("Audio playback complete");
//                 resolve();
//             }
//         };

//         const openAplay = () => {
//             if (aplay) return;

//             console.log("Starting audio playback...");

//             aplay = spawn("aplay", [
//                 "-q",
//                 "-D", ALSA_DEVICE,
//                 "-f", "S16_LE",
//                 "-c", "1",
//                 "-r", String(OUT_SAMPLE_RATE),
//                 "-t", "raw",
//             ], {
//                 stdio: ['pipe', 'ignore', 'ignore']
//             });

//             aplay.on("close", (code) => {
//                 console.log(`aplay finished (code: ${code})`);
//                 aplayFinished = true;
//                 checkComplete();
//             });

//             aplay.on("error", (err) => {
//                 console.error("aplay error:", err);
//                 aplayFinished = true;
//                 safeClose();
//                 reject(err);
//             });
//         };

//         const safeClose = () => {
//             try { if (aplay?.stdin && !aplay.stdin.destroyed) aplay.stdin.end(); } catch { }
//             try { if (aplay && aplay.pid) aplay.kill("SIGINT"); } catch { }
//             try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch { }
//         };

//         ws.on("open", () => {
//             ws.send(JSON.stringify({
//                 type: "session.update",
//                 session: {
//                     modalities: ["audio", "text"],
//                     output_audio_format: "pcm16",
//                     voice: "alloy",
//                 },
//             }));

//             ws.send(JSON.stringify({
//                 type: "conversation.item.create",
//                 item: {
//                     type: "message",
//                     role: "user",
//                     content: [{ type: "input_text", text: transcript }],
//                 },
//             }));

//             ws.send(JSON.stringify({
//                 type: "response.create",
//                 response: {
//                     modalities: ["audio", "text"],
//                     instructions: "Answer concisely for spoken playback. Keep the answer to less than 2 sentences.",
//                     output_audio_format: "pcm16",
//                     voice: "alloy"
//                 },
//             }));
//         });

//         ws.on("message", (raw) => {
//             const evt = JSON.parse(raw.toString());
//             const t = evt.type as string;

//             switch (t) {
//                 case "response.audio.delta": {
//                     if (!startedAudio) {
//                         openAplay();
//                         startedAudio = true;
//                     }
//                     const b64 = evt.delta as string;
//                     const buf = Buffer.from(b64, "base64");

//                     if (aplay?.stdin?.writable) aplay.stdin.write(buf);
//                     break;
//                 }

//                 case "response.completed":
//                 case "response.audio.done": {
//                     console.log("Audio stream complete");
//                     audioStreamComplete = true;

//                     if (aplay?.stdin?.writable) {
//                         aplay.stdin.end();
//                     }

//                     checkComplete();
//                     break;
//                 }

//                 case "error": {
//                     console.error("Realtime error:", evt.error);
//                     safeClose();
//                     reject(new Error(evt.error?.message || "Realtime error"));
//                     break;
//                 }
//             }
//         });

//         ws.on("close", () => {
//             if (!startedAudio) {
//                 resolve();
//             }
//         });

//         ws.on("error", (e) => {
//             safeClose();
//             reject(e);
//         });

//         setTimeout(() => {
//             if (!audioStreamComplete || !aplayFinished) {
//                 console.warn("Audio timeout");
//                 safeClose();
//                 resolve();
//             }
//         }, 30000);
//     });
// }


export async function speak(transcript: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url, "realtime", {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1",
            },
        });

        let aplay: ReturnType<typeof spawn> | null = null;
        let startedAudio = false;
        let audioStreamComplete = false;
        let aplayFinished = false;

        // function-call streaming state
        let pendingToolId: string | null = null;     // item.id from response.output_item.added
        let pendingToolName: string | null = null;   // item.name
        let pendingArgsText = "";                    // accumulate JSON chars

        const tools = [weatherToolSchema];

        const checkComplete = () => {
            if (audioStreamComplete && aplayFinished) resolve();
        };
        const openAplay = () => {
            if (aplay) return;
            aplay = spawn("aplay",
                ["-q", "-D", ALSA_DEVICE, "-f", "S16_LE", "-c", "1", "-r", String(OUT_SAMPLE_RATE), "-t", "raw"],
                { stdio: ["pipe", "ignore", "ignore"] }
            );
            aplay.on("close", () => { aplayFinished = true; checkComplete(); });
            aplay.on("error", (err) => { aplayFinished = true; safeClose(); reject(err); });
        };
        const safeClose = () => {
            try { if (aplay?.stdin && !aplay.stdin.destroyed) aplay.stdin.end(); } catch { }
            try { if (aplay && aplay.pid) aplay.kill("SIGINT"); } catch { }
            try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch { }
        };

        ws.on("open", () => {
            // session config
            ws.send(JSON.stringify({
                type: "session.update",
                session: { modalities: ["audio", "text"], output_audio_format: "pcm16", voice: "alloy" }
            }));

            // user message
            ws.send(JSON.stringify({
                type: "conversation.item.create",
                item: { type: "message", role: "user", content: [{ type: "input_text", text: transcript }] }
            }));

            // ask model to answer and allow tool use
            ws.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["audio", "text"],
                    instructions: "Answer concisely for spoken playback (<= 2 sentences). If weather is requested, call get_weather.",
                    output_audio_format: "pcm16",
                    voice: "alloy",
                    tool_choice: "auto",
                    tools
                }
            }));
        });

        ws.on("message", async (raw) => {
            const evt = JSON.parse(raw.toString());
            const type = evt.type as string;
            // console.log("event:", type);

            switch (type) {
                // ---------- NEW function-call streaming path ----------
                case "response.output_item.added": {
                    // A new output item was added (could be text, tool call, etc.)
                    const item = evt.item;
                    if (item?.type === "function_call") {
                        pendingToolId = item.id;
                        pendingToolName = item.name;
                        pendingArgsText = "";
                    }
                    break;
                }
                case "response.function_call_arguments.delta": {
                    // Chunks of JSON arguments
                    pendingArgsText += evt.delta || "";
                    break;
                }
                case "response.function_call_arguments.done": {
                    // We have full JSON args — run the tool
                    if (!pendingToolId || !pendingToolName) break;
                    let parsed: any = {};
                    try { parsed = pendingArgsText ? JSON.parse(pendingArgsText) : {}; }
                    catch { parsed = {}; }

                    try {
                        let output: any;
                        if (pendingToolName === "get_weather") {
                            output = await runWeatherTool(parsed);
                        } else {
                            output = { ok: false, error: `Unknown tool: ${pendingToolName}` };
                        }

                        // Send tool output back
                        ws.send(JSON.stringify({
                            type: "response.tool_output",
                            tool_call_id: pendingToolId,
                            output
                        }));

                        // IMPORTANT: the original response likely already ended (you saw `response.done`).
                        // Ask the model to continue and produce the final audio/text:
                        ws.send(JSON.stringify({
                            type: "response.create",
                            response: {
                                modalities: ["audio", "text"],
                                instructions: "Use the provided tool result and reply briefly for spoken playback.",
                                output_audio_format: "pcm16",
                                voice: "alloy"
                            }
                        }));
                    } finally {
                        // clear pending state
                        pendingToolId = null;
                        pendingToolName = null;
                        pendingArgsText = "";
                    }
                    break;
                }

                // ---------- Back-compat: older single-shot tool event ----------
                case "response.tool_call": {
                    const { id: tool_call_id, name, arguments: args } = evt;
                    try {
                        let output: any;
                        if (name === "get_weather") output = await runWeatherTool(args || {});
                        else output = { ok: false, error: `Unknown tool: ${name}` };

                        ws.send(JSON.stringify({ type: "response.tool_output", tool_call_id, output }));
                        ws.send(JSON.stringify({
                            type: "response.create",
                            response: {
                                modalities: ["audio", "text"],
                                instructions: "Use the provided tool result and reply briefly for spoken playback.",
                                output_audio_format: "pcm16",
                                voice: "alloy"
                            }
                        }));
                    } catch (e: any) {
                        ws.send(JSON.stringify({ type: "response.tool_output", tool_call_id, output: { ok: false, error: e?.message || "Tool failed" } }));
                    }
                    break;
                }

                // ---------- Audio streaming ----------
                case "response.audio.delta": {
                    if (!startedAudio) { openAplay(); startedAudio = true; }
                    const buf = Buffer.from(evt.delta as string, "base64");
                    if (aplay?.stdin?.writable) aplay.stdin.write(buf);
                    break;
                }
                case "response.audio.done":
                case "response.completed": {
                    audioStreamComplete = true;
                    if (aplay?.stdin?.writable) aplay.stdin.end();
                    checkComplete();
                    break;
                }

                // ---------- Optional text stream ----------
                case "response.output_text.delta":
                    // process.stdout.write(evt.delta);
                    break;

                // ---------- Errors ----------
                case "error": {
                    console.error("Realtime error:", evt.error);
                    safeClose();
                    reject(new Error(evt.error?.message || "Realtime error"));
                    break;
                }

                default:
                    // console.log(type, evt);
                    break;
            }
        });

        ws.on("close", () => {
            if (!startedAudio) resolve();
        });
        ws.on("error", (e) => {
            safeClose();
            reject(e);
        });

        // Safety timeout
        setTimeout(() => {
            if (!audioStreamComplete || !aplayFinished) {
                console.warn("Audio timeout");
                safeClose();
                resolve();
            }
        }, 30000);
    });
}

export async function transcribe(
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
            console.log("Audio is playing, not transcribing");
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
            console.log("Starting capture loop...");
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
                console.error("Capture loop error:", error);
            } finally {
                captureLoopRunning = false;
                console.log("Capture loop ended");
            }
        }


        ws.on("open", () => {
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
                    },
                },
            }));
        });

        // handle server events
        ws.on("message", async (raw) => {
            const evt = JSON.parse(raw.toString());
            const t = evt.type as string;
            switch (t) {
                case "session.updated": {
                    isCapturingSpeech = true;

                    if (!captureLoopRunning) {
                        captureLoop();
                    }
                    break;
                }

                case "input_audio_buffer.speech_started":
                    console.log("Speech detected by server");
                    break;

                case "input_audio_buffer.speech_stopped":
                    // Stop sending and finalize this utterance
                    console.log("speech stopped event sent")
                    isCapturingSpeech = false;
                    break;

                case "input_audio_buffer.committed":
                    console.log("Buffer committed, waiting for transcription...");
                    break;

                case "conversation.item.input_audio_transcription.completed":
                case "input_audio_transcription.completed":
                case "transcription.final": {
                    const finalText = evt.transcript || evt.text || "";
                    transcriptDone = true;
                    clearTimeout(overallTO);
                    console.log("Transcription:", JSON.stringify(finalText));
                    cleanup();
                    resolve((finalText || "").trim());
                    break;
                }

                case "conversation.item.created":
                    const item = evt.item || {};
                    if (item.type === "message" && item.role === "user") {
                        console.log("Processing transcription...");
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

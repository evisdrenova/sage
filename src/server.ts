import { Porcupine, BuiltinKeyword } from "@picovoice/porcupine-node";
import { PvRecorder } from "@picovoice/pvrecorder-node";
import { config } from "dotenv";
import { speak, transcribe } from "./speak";
import { sleep } from "./utils";
import { SessionTimer } from "./timer";

import WebSocket from "ws";
import { spawn } from "child_process";

import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

config();

const FRAME_LENGTH = 512;
const DEVICE_INDEX = 3;
const SENSITIVITY = 0.5;
const REFRACTORY_MS = 750; //prevents the wake word from being called multiple times
const KEYWORD = BuiltinKeyword.COMPUTER;
let IS_PLAYING_AUDIO = false;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY");


enum Mode { Wake, Converse }

export async function start() {
    const ACCESS_KEY = process.env.PICOVOICE_ACCESS_KEY;
    if (!ACCESS_KEY) throw new Error("PICOVOICE_ACCESS_KEY not set in environment");


    let porcupine: Porcupine | null = null;
    let recorder: PvRecorder | null = null;
    let shuttingDown = false;
    let lastDetect = 0;
    let mode: Mode = Mode.Wake;

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
        porcupine = new Porcupine(ACCESS_KEY, [KEYWORD], [SENSITIVITY]);
        recorder = new PvRecorder(FRAME_LENGTH, DEVICE_INDEX);

        await recorder.start();
        console.log("Ready! Listening for wake word ...");

        while (recorder.isRecording) {
            if (mode === Mode.Wake) {
                const frame = await recorder.read();
                const idx = porcupine.process(frame);
                if (idx >= 0) {
                    const now = Date.now();
                    if (now - lastDetect < REFRACTORY_MS) continue;
                    lastDetect = now;

                    console.log("Wake word detected!");
                    mode = Mode.Converse
                    // await converse(recorder);
                    await converseWithRealtime(recorder, {
                        vadThreshold: 0.5,
                        silenceMs: 800,
                        sessionIdleMs: 12000,
                    });
                    mode = Mode.Wake
                }
            }
        }
    } catch (err) {
        console.error("Error:", err);
        throw err;
    } finally {
        await shutdown();
    }
}

async function converse(
    recorder: PvRecorder,
) {
    const sessionIdleMs = 12000;
    const turnSilenceMs = 800;

    console.log("🗣️ Conversation mode (no wake word needed) — I'm listening…");

    const sessionTimer = new SessionTimer(sessionIdleMs);

    while (!sessionTimer.isExpired()) {

        if (IS_PLAYING_AUDIO) {
            console.log("Audio is playing, waiting...");
            sessionTimer.pause();

            while (IS_PLAYING_AUDIO) {
                await sleep(100);
            }

            console.log("Audio finished, waiting 2 seconds for echoes...");
            await sleep(2000);

            sessionTimer.resume();
        }

        const transcript = await transcribe(recorder, IS_PLAYING_AUDIO, {
            silenceMs: turnSilenceMs,
            maxOverallMs: Math.min(sessionTimer.getRemainingMs(), sessionIdleMs),
        });

        if (!transcript) {
            console.log("No transcript - session ending");
            break;
        }

        sessionTimer.reset();

        sessionTimer.pause();
        IS_PLAYING_AUDIO = true;
        console.log("Audio playback started");
        recorder.stop()

        try {
            await speak(transcript);
        } finally {
            IS_PLAYING_AUDIO = false;
            console.log("Audio playback stopped");
            sessionTimer.resume();
            recorder.start()
        }
    }

    console.log("↩Returning to wake mode");
}

export function setAudioPlayingState(playing: boolean) {
    IS_PLAYING_AUDIO = playing;
    console.log(playing ? "Audio playback started" : "Audio playback stopped");
}

if (require.main === module) {
    start().catch((e) => {
        console.error("Startup failed:", e);
        process.exit(1);
    });
}

const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

const SAMPLE_RATE = 16000;
const ALSA_DEVICE = "plughw:4,0"

// async function converseWithRealtime(recorder: PvRecorder, {
//     vadThreshold = 0.5,
//     silenceMs = 600,
//     sessionIdleMs = 12000,
// } = {}): Promise<void> {

//     const agent = new RealtimeAgent({
//         name: 'Greeter',
//         instructions: 'Greet the user with cheer and answer questions.',
//     });


//     const ws = new WebSocket(url, "realtime", {
//         headers: {
//             Authorization: `Bearer ${OPENAI_API_KEY}`,
//             "OpenAI-Beta": "realtime=v1",
//         },
//     });

//     let sending = false;
//     let closed = false;
//     let aplay: ReturnType<typeof spawn> | null = null;
//     let aplayDone = false;
//     let responseDone = false;

//     const openAplay = () => {
//         if (aplay) return;
//         aplay = spawn("aplay", [
//             "-q",
//             "-D", ALSA_DEVICE,
//             "-f", "S16_LE",
//             "-c", "1",
//             "-r", String(SAMPLE_RATE),
//             "-t", "raw",
//         ], { stdio: ["pipe", "ignore", "ignore"] });

//         aplay.on("close", () => { aplayDone = true; maybeFinish(); });
//         aplay.on("error", () => { aplayDone = true; maybeFinish(); });
//     };

//     const safeClose = () => {
//         if (closed) return;
//         closed = true;
//         try { aplay?.stdin?.end(); } catch { }
//         try { if (aplay && aplay.pid) aplay.kill("SIGINT"); } catch { }
//         try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch { }
//     };

//     const maybeFinish = () => {
//         if (responseDone && (aplayDone || !aplay)) {
//             safeClose();
//         }
//     };

//     // 1) When WS opens, configure session
//     ws.on("open", () => {
//         ws.send(JSON.stringify({
//             type: "session.update",
//             session: {
//                 // let the model manage turns and speaking:
//                 modalities: ["audio", "text"],
//                 output_audio_format: "pcm16",
//                 voice: "alloy",
//                 turn_detection: {
//                     type: "server_vad",
//                     threshold: vadThreshold,
//                     prefix_padding_ms: 300,
//                     silence_duration_ms: silenceMs,
//                 },
//                 // optional: keep the session from idling immediately
//                 // keep_alive: "15s"
//             },
//         }));

//         // kick off a response “turn”; the model will listen for audio
//         ws.send(JSON.stringify({
//             type: "response.create",
//             response: {
//                 modalities: ["audio", "text"],
//                 instructions: "You are a voice assistant. Be brief and helpful.",
//             },
//         }));
//     });

//     // 2) Handle server events
//     ws.on("message", async (raw) => {
//         const evt = JSON.parse(raw.toString());
//         const t = evt.type as string;

//         switch (t) {
//             case "session.updated":
//                 // start streaming mic frames now
//                 sending = true;
//                 streamMic().catch(() => { });
//                 break;

//             case "input_audio_buffer.speech_started":
//                 // optional logging
//                 break;

//             case "input_audio_buffer.speech_stopped":
//                 // stop sending; the server will finish this turn
//                 sending = false;
//                 // You can optionally commit, but server VAD commits implicitly:
//                 // ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
//                 break;

//             case "response.output_text.delta":
//                 // optional: accumulate text for logs
//                 // process.stdout.write(evt.delta);
//                 break;

//             case "response.audio.delta": {
//                 // stream PCM16 audio to ALSA
//                 openAplay();
//                 const b64 = evt.delta as string;
//                 const buf = Buffer.from(b64, "base64");
//                 if (aplay?.stdin?.writable) aplay.stdin.write(buf);
//                 break;
//             }

//             case "response.audio.done":
//             case "response.completed":
//                 responseDone = true;
//                 if (aplay?.stdin?.writable) aplay.stdin.end();
//                 maybeFinish();
//                 break;

//             case "rate_limits.updated":
//                 break;

//             case "error":
//                 console.error("Realtime error:", evt.error);
//                 safeClose();
//                 break;

//             default:
//                 // console.log("evt:", t, evt);
//                 break;
//         }
//     });

//     ws.on("close", () => {
//         aplayDone = true;
//     });

//     ws.on("error", (e) => {
//         console.error("WS error:", e);
//         safeClose();
//     });

//     // 3) Mic → server loop (PCM16 base64)
//     async function streamMic() {
//         try {
//             while (!closed && ws.readyState === WebSocket.OPEN) {
//                 if (!sending || !recorder.isRecording) {
//                     // light sleep to avoid tight spin when paused
//                     await sleep(10);
//                     continue;
//                 }
//                 const frame = await recorder.read();              // Int16Array length 512
//                 const buf = Buffer.from(frame.buffer);            // raw PCM16LE
//                 ws.send(JSON.stringify({
//                     type: "input_audio_buffer.append",
//                     audio: buf.toString("base64"),
//                 }));
//             }
//         } catch (e) {
//             // recorder stopped or ws closed
//         }
//     }
// }


const MODEL = "gpt-4o-realtime-preview-2024-12-17";
const MIC_DEVICE = -1;          // -1 = default device; or set your index



function tightArrayBufferOf(int16Array: Int16Array): ArrayBuffer {
    // Create a new ArrayBuffer with exact size needed
    const buffer = new ArrayBuffer(int16Array.length * 2); // 2 bytes per Int16
    const view = new Int16Array(buffer);
    view.set(int16Array);
    return buffer;
}
async function converseWithRealtime(recorder: PvRecorder, {
    vadThreshold = 0.5,
    silenceMs = 600,
    sessionIdleMs = 12000,
} = {}): Promise<void> {

    const agent = new RealtimeAgent({
        name: "Assistant",
        instructions: "You are a helpful voice assistant. Be concise and friendly.",
    });

    // Configure session for audio in/out and server-side VAD
    const session = new RealtimeSession(agent, {
        transport: "websocket",
        model: MODEL,
        config: {
            outputModalities: ["audio", "text"],
            audio: {
                input: {
                    turnDetection: {
                        type: "server_vad",
                        threshold: vadThreshold,
                        prefix_padding_ms: 300,
                        silence_duration_ms: silenceMs,
                    },
                },
                output: {
                    voice: 'alloy',
                    format: "pcm16"
                },
            },
        },
    });

    console.log("1 - Session configured");

    // ---- audio OUT (agent -> ALSA) ----
    let aplay: ReturnType<typeof spawn> | null = null;
    const ensureAplay = () => {
        if (aplay) return;
        aplay = spawn("aplay", [
            "-q",
            "-D", ALSA_DEVICE,
            "-f", "S16_LE",
            "-c", "1",
            "-r", String(SAMPLE_RATE),
            "-t", "raw",
        ], { stdio: ["pipe", "ignore", "ignore"] });

        aplay.on("close", () => {
            console.log("🔊 aplay closed");
            aplay = null;
        });
        aplay.on("error", (err) => {
            console.error("🔊 aplay error:", err);
            aplay = null;
        });
    };

    let framesSent = 0;
    let bytesSent = 0;
    let lastRxAt = Date.now();
    let audioReceived = false;

    session.on("audio", (evt) => {
        const size = evt.data?.byteLength ?? 0;
        lastRxAt = Date.now();
        audioReceived = true;
        console.log(`🔊 rx audio: ${size} bytes`);

        ensureAplay();
        if (aplay?.stdin?.writable && size > 0) {
            const buf = Buffer.from(new Uint8Array(evt.data));
            aplay.stdin.write(buf);
        }
    });

    console.log("2 - Audio handler set");

    session.on("text", (evt) => {
        if (evt.delta) process.stdout.write(`📝 ${evt.delta}`);
        if (evt.done) process.stdout.write("\n");
    });

    // Add more event listeners for debugging
    session.on("connected", () => {
        console.log("✅ Session connected successfully");
    });

    session.on("response.created", () => {
        console.log("🤖 Agent is creating response");
    });

    session.on("response.done", () => {
        console.log("✅ Agent response complete");
    });

    session.on("input_audio_buffer.speech_started", () => {
        console.log("🎤 Speech detected by server VAD!");
    });

    session.on("input_audio_buffer.speech_stopped", () => {
        console.log("🤐 Speech ended by server VAD");
    });

    session.on("conversation.item.created", (evt) => {
        console.log("📄 New conversation item:", evt.type);
    });

    console.log("3 - Event listeners set");

    let active = true;
    session.on("disconnect", () => {
        console.log("❌ Session disconnected");
        active = false;
    });
    session.on("error", (err) => {
        console.error("❌ Session error:", err);
        active = false;
    });
    session.on("close", () => {
        console.log("❌ Session closed");
        active = false;
    });

    const hb = setInterval(() => {
        console.log(`❤️ active=${active} framesSent=${framesSent} bytesSent=${bytesSent} audioRx=${audioReceived}`);

        // Warn if no audio back in 10s
        if (Date.now() - lastRxAt > 10000) {
            console.warn("⏳ no audio/text from agent for 10s — still listening…");
        }
    }, 5000);

    console.log("4 - Heartbeat started");

    try {
        // Connect the session
        await session.connect({ apiKey: OPENAI_API_KEY });
        console.log("5 - Connected to OpenAI");

        // Start mic
        const mic = new PvRecorder(FRAME_LENGTH, DEVICE_INDEX);
        await mic.start();
        console.log("🎙️ Mic started — speak when ready");
        console.log("6 - Mic initialized");

        // Give a moment for connection to stabilize
        await sleep(1000);

        // Send initial test to see if connection works
        console.log("📤 Sending initial silence to test connection...");
        const testBuffer = new ArrayBuffer(1024); // 512 samples * 2 bytes = 1024 bytes
        session.sendAudio(testBuffer);

        let consecutiveQuietFrames = 0;
        const MAX_QUIET_FRAMES = 100; // About 3 seconds of quiet before warning

        // Main loop: read frames and push to the session
        while (active) {
            if (!mic.isRecording) {
                await sleep(10);
                continue;
            }

            const frame = await mic.read(); // Int16Array (FRAME_LENGTH samples)

            // Debug VU: find peak absolute sample to see if mic is "hot"
            let peak = 0;
            let sum = 0;
            for (let i = 0; i < frame.length; i++) {
                const v = Math.abs(frame[i] ?? 0);
                if (v > peak) peak = v;
                sum += v;
            }
            const avg = sum / frame.length;

            // Convert to ArrayBuffer properly
            const abuf = tightArrayBufferOf(frame);

            // Send to OpenAI
            session.sendAudio(abuf);
            framesSent++;
            bytesSent += abuf.byteLength;

            // Track quiet periods
            if (peak < 100) {
                consecutiveQuietFrames++;
            } else {
                consecutiveQuietFrames = 0;
            }

            // Log every ~1s @ 512 samples/16kHz ≈ 32ms per frame => ~31 frames ≈ 1s
            if (framesSent % 31 === 0) {
                console.log(
                    `🎙️ tx frame#${framesSent} (+${abuf.byteLength} bytes), peak=${peak}, avg=${avg.toFixed(1)}`
                );

                if (peak < 200) {
                    console.log("🤫 very quiet input — check mic gain / device index");
                }

                if (consecutiveQuietFrames > MAX_QUIET_FRAMES) {
                    console.warn(`⚠️ No significant audio for ${consecutiveQuietFrames} frames (~${(consecutiveQuietFrames * 32).toFixed(0)}ms)`);
                }
            }

            // Small delay to prevent overwhelming
            await sleep(5);
        }

    } catch (error) {
        console.error("💥 Error in conversation:", error);
    } finally {
        console.log("🧹 Cleaning up...");
        clearInterval(hb);

        try {
            await mic.stop();
            mic.release();
            console.log("🎙️ Mic stopped and released");
        } catch (err) {
            console.error("Error stopping mic:", err);
        }

        try {
            if (aplay?.stdin) {
                aplay.stdin.end();
                console.log("🔊 aplay stdin ended");
            }
        } catch (err) {
            console.error("Error ending aplay stdin:", err);
        }

        try {
            if (aplay && aplay.pid) {
                aplay.kill("SIGTERM");
                console.log("🔊 aplay process killed");
            }
        } catch (err) {
            console.error("Error killing aplay:", err);
        }

        try {
            await session.disconnect?.();
            console.log("🔌 Session disconnected");
        } catch (err) {
            console.error("Error disconnecting session:", err);
        }
    }
}

// async function converseWithRealtime(recorder: PvRecorder, {
//     vadThreshold = 0.5,
//     silenceMs = 600,
//     sessionIdleMs = 12000,
// } = {}): Promise<void> {
//     const agent = new RealtimeAgent({
//         name: "Voice Assistant",
//         instructions: "You are a helpful voice assistant. Be brief, friendly, and respond clearly.",
//         voice: "alloy",
//         modalities: ["audio", "text"],
//         turnDetection: {
//             type: "server_vad",
//             threshold: vadThreshold,
//             silenceDurationMs: silenceMs,
//             prefixPaddingMs: 300,
//         },
//         outputAudioFormat: "pcm16",
//     });

//     const session = new RealtimeSession(agent, {
//         transport: "websocket",
//         model: "gpt-4o-realtime-preview-2024-12-17", // Use the actual model name
//     });

//     // Audio output handling (PCM16 from OpenAI -> ALSA)
//     let aplay: ReturnType<typeof spawn> | null = null;
//     let conversationActive = true;

//     const ensureAplay = () => {
//         if (aplay) return;
//         aplay = spawn("aplay", [
//             "-q",
//             "-D", ALSA_DEVICE,
//             "-f", "S16_LE",
//             "-c", "1",
//             "-r", String(SAMPLE_RATE),
//             "-t", "raw",
//         ], { stdio: ["pipe", "ignore", "ignore"] });

//         aplay.on("close", () => {
//             aplay = null;
//         });
//         aplay.on("error", (err) => {
//             console.error("ALSA playback error:", err);
//             aplay = null;
//         });
//     };

//     // Handle audio output from OpenAI
//     session.on("audio", (event) => {
//         // event.data is an ArrayBuffer of PCM16 mono @ 16kHz
//         ensureAplay();
//         if (!aplay?.stdin?.writable) return;

//         const buffer = Buffer.from(event.data);
//         aplay.stdin.write(buffer);
//     });

//     // Optional: Handle text responses for logging
//     session.on("text", (event) => {
//         if (event.delta) {
//             process.stdout.write(event.delta);
//         }
//         if (event.done) {
//             process.stdout.write("\n");
//         }
//     });

//     // Handle session events
//     session.on("connected", () => {
//         console.log("🔗 Connected to OpenAI Realtime API");
//     });

//     session.on("disconnected", () => {
//         console.log("❌ Disconnected from OpenAI");
//         conversationActive = false;
//     });

//     session.on("error", (error) => {
//         console.error("❌ Session error:", error);
//         conversationActive = false;
//     });

//     try {
//         // Connect to OpenAI
//         await session.connect({ apiKey: OPENAI_API_KEY });
//         console.log("🎙️ Listening... speak when ready");

//         // Audio input loop: stream from PvRecorder to OpenAI
//         let isStreaming = true;

//         const streamAudio = async () => {
//             while (isStreaming && conversationActive && recorder.isRecording && session.isConnected()) {
//                 try {
//                     const frame = await recorder.read(); // Int16Array

//                     // Convert Int16Array to ArrayBuffer
//                     // PvRecorder returns Int16Array, we need ArrayBuffer
//                     const arrayBuffer = frame.buffer.slice(
//                         frame.byteOffset,
//                         frame.byteOffset + frame.byteLength
//                     );

//                     session.sendAudio(arrayBuffer);

//                     // Small delay to prevent overwhelming the connection
//                     await new Promise(resolve => setTimeout(resolve, 5));

//                 } catch (error) {
//                     console.error("Audio streaming error:", error);
//                     break;
//                 }
//             }
//         };

//         // Start audio streaming
//         streamAudio();

//         // Wait for conversation to end or timeout
//         await new Promise<void>((resolve) => {
//             const timeout = setTimeout(() => {
//                 console.log("⏱️ Conversation timeout");
//                 isStreaming = false;
//                 conversationActive = false;
//                 resolve();
//             }, sessionIdleMs);

//             session.on("disconnected", () => {
//                 clearTimeout(timeout);
//                 isStreaming = false;
//                 resolve();
//             });

//             // You could also listen for specific conversation end events
//             // depending on what the SDK provides
//         });

//     } catch (error) {
//         console.error("Connection error:", error);
//     } finally {
//         // Cleanup
//         conversationActive = false;

//         if (aplay) {
//             try {
//                 aplay.stdin?.end();
//                 aplay.kill("SIGTERM");
//             } catch (error) {
//                 console.error("Error closing audio output:", error);
//             }
//         }

//         try {
//             await session.disconnect();
//         } catch (error) {
//             console.error("Error disconnecting session:", error);
//         }
//     }
// }
import { Porcupine, BuiltinKeyword } from "@picovoice/porcupine-node";
import { PvRecorder } from "@picovoice/pvrecorder-node";
import { config } from "dotenv";
import { speak, transcribe } from "./speak";
import { sleep } from "./utils";
import { SessionTimer } from "./timer";
import { spawn, ChildProcess } from 'child_process';

import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

config();

const FRAME_LENGTH = 512;
const DEVICE_INDEX = 3;
const SENSITIVITY = 0.5;
const REFRACTORY_MS = 750;
const KEYWORD = BuiltinKeyword.COMPUTER;
let IS_PLAYING_AUDIO = false;
const SAMPLE_RATE = 24000;
const ALSA_DEVICE = "plughw:4,0"
const MODEL = "gpt-4o-realtime-preview-2024-12-17";


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
                    await converse(recorder, {
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

async function converseOld(
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



function tightArrayBufferOf(int16Array: Int16Array): ArrayBuffer {
    // Create a new ArrayBuffer with exact size needed
    const buffer = new ArrayBuffer(int16Array.length * 2); // 2 bytes per Int16
    const view = new Int16Array(buffer);
    view.set(int16Array);
    return buffer;
}
async function converse(recorder: PvRecorder, {
    vadThreshold = 0.5,
    silenceMs = 600,
    sessionIdleMs = 12000,
} = {}): Promise<void> {

    const agent = new RealtimeAgent({
        name: "Assistant",
        instructions: "You are a helpful voice assistant. Be friendly and concise. Most of your respones should just be 1-2 sentences at most.",
    });

    // Configure session for audio in/out and server-side VAD
    const session = new RealtimeSession(agent, {
        transport: "websocket",
        model: MODEL,
        config: {
            outputModalities: ["audio"],
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
    let aplay: ChildProcess | null = null;

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

    // triggered when there is new audio ready to play to the user
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

    session.on("audio_start", (evt) => {
        console.log("agent is starting to generate audio", evt)
    });


    session.on("error", (evt) => {
        console.log("there was an error", evt)
    });


    console.log("3 - Event listeners set");

    let active = true;

    session.on("error", (err) => {
        console.error("❌ Session error:", err);
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

    const mic = new PvRecorder(FRAME_LENGTH, DEVICE_INDEX);

    try {
        // Connect the session
        await session.connect({ apiKey: OPENAI_API_KEY });
        console.log("5 - Connected to OpenAI");

        // Start mic
        await mic.start();
        console.log("🎙️ Mic started — speak when ready");

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
        await cleanUpStream(mic, aplay, session)
    }
}

async function cleanUpStream(
    mic: PvRecorder | null,
    aplay: ChildProcess | null,
    session: RealtimeSession<unknown>
) {

    if (mic) {
        try {
            await mic.stop();
            mic.release();
            console.log("🎙️ Mic stopped and released");
        } catch (err) {
            console.error("Error stopping mic:", err);
        }
    }

    if (aplay) {
        try {
            if (aplay.stdin?.writable) {
                aplay.stdin.end();
                console.log("🔊 aplay stdin ended");
            }
        } catch (err) {
            console.error("Error ending aplay stdin:", err);
        }

        try {
            if (aplay.pid) {
                aplay.kill("SIGTERM");
                console.log("🔊 aplay process killed");
            }
        } catch (err) {
            console.error("Error killing aplay:", err);
        }
    }

    try {
        if (session) {
            await session.close();
            console.log("🔌 Session disconnected");
        }
    } catch (err) {
        console.error("Error disconnecting session:", err);
    }
}


if (require.main === module) {
    start().catch((e) => {
        console.error("Startup failed:", e);
        process.exit(1);
    });
}
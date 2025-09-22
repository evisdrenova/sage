import { PvRecorder } from "@picovoice/pvrecorder-node";
import { sleep } from "./utils";
import { spawn, ChildProcess } from 'child_process';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { config } from "dotenv";

config();

const SAMPLE_RATE = 24000;
const ALSA_DEVICE = "plughw:4,0"
const MODEL = "gpt-4o-realtime-preview-2024-12-17";
const VAD_THRESHOLD = 0.7
const SILENCE_MS = 1000
const FRAME_LENGTH = 512;
const DEVICE_INDEX = 3;


const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY");


export async function converse(): Promise<void> {
    const agent = new RealtimeAgent({
        name: "Assistant",
        instructions: "You are a helpful voice assistant. Be friendly and concise. Most of your respones should just be 1-2 sentences at most.",
    });

    const session = new RealtimeSession(agent, {
        transport: "websocket",
        model: MODEL,
        config: {
            instructions: "You are a helpful voice assistant. Be friendly and concise. Most of your respones should just be 1-2 sentences at most.",
            outputModalities: ["audio"],
            audio: {
                input: {
                    turnDetection: {
                        type: "server_vad",
                        threshold: VAD_THRESHOLD,
                        prefix_padding_ms: 300,
                        silence_duration_ms: SILENCE_MS,
                    },
                },
                output: {
                    voice: 'alloy',
                    format: "pcm16"
                },
            },
        },
    })
    let isPlayingAudio = false;

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
            console.log("🔊 Audio playback finished");
            aplay = null;
            isPlayingAudio = false;
        });

        aplay.on("error", (err) => {
            console.error("aplay error:", err);
            aplay = null;
            isPlayingAudio = false;
        });
    };

    let framesSent = 0;
    let bytesSent = 0;
    let lastRxAt = Date.now();
    let audioReceived = false;
    let micPaused = false;

    // triggered when there is new audio ready to play to the user
    session.on("audio", (evt) => {
        const size = evt.data?.byteLength ?? 0;
        lastRxAt = Date.now();
        audioReceived = true;

        ensureAplay();
        if (aplay?.stdin?.writable && size > 0) {
            const buf = Buffer.from(new Uint8Array(evt.data));
            aplay.stdin.write(buf);
        }
    });

    session.on("audio_start", (evt) => {
        console.log("🔊 Agent is starting to speak...");
        isPlayingAudio = true;
        micPaused = true;
    });

    session.on("agent_end", (evt) => {
        console.log("✅ Agent finished response");
        // Add a small delay before resuming mic to let audio finish
        setTimeout(() => {
            micPaused = false;
            console.log("🎙️ Microphone resumed");
        }, 500); // 500ms delay
        isPlayingAudio = false;
    });


    session.on("error", (evt) => {
        console.log("there was an error", evt)
    });


    session.on("agent_end", (evt) => {
        console.log("the agent is done ")
    })


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

    const mic = new PvRecorder(FRAME_LENGTH, DEVICE_INDEX);

    try {
        // Connect the session
        await session.connect({ apiKey: OPENAI_API_KEY });

        // Start mic
        await mic.start();
        console.log("Mic started — speak when ready");

        // Give a moment for connection to stabilize
        await sleep(1000);

        // Main loop
        while (active) {
            if (!mic.isRecording || micPaused) {
                await sleep(10);
                continue;
            }

            const frame = await mic.read();
            const abuf = converAudioToArrayBuffer(frame);
            session.sendAudio(abuf);

            framesSent++; // Track frames for debugging
            bytesSent += abuf.byteLength;

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


function converAudioToArrayBuffer(int16Array: Int16Array): ArrayBuffer {
    const buffer = new ArrayBuffer(int16Array.length * 2);
    const view = new Int16Array(buffer);
    view.set(int16Array);
    return buffer;
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
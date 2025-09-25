import { spawn, ChildProcess } from 'child_process';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { config } from "dotenv";

config();

const SAMPLE_RATE = 16000;
const PLAYBACK_RATE = 24000
const PULSE_SOURCE = "echocancel_source";
const PULSE_SINK = "default";
const MODEL = "gpt-4o-realtime-preview-2024-12-17";
const VAD_THRESHOLD = 0.7;
const SILENCE_MS = 1000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY");

// spawn pulse audio parec process to capture user prompt
function startPulseCapture(device = PULSE_SOURCE, rate = SAMPLE_RATE, channels = 1) {
    const rec = spawn("parec", [
        `--device=${device}`,
        "--raw",
        "--format=s16le",
        `--rate=${rate}`,
        `--channels=${channels}`,
    ]);
    rec.stderr.on("data", (d) => console.debug("[parec]", d.toString().trim()));
    return rec;
}

// spawn aplay child process to play back the audio from the agent
function startAplay(rate = PLAYBACK_RATE): ChildProcess {
    const p = spawn(
        "aplay",
        [
            "-q",
            "-D",
            PULSE_SINK,
            "-f",
            "S16_LE",
            "-c",
            "1",
            "-r",
            String(rate),
            "-t",
            "raw",
        ],
        { stdio: ["pipe", "ignore", "ignore"] }
    );
    p.on("data", (d) => console.debug("[aplay]", d.toString().trim()));
    return p;
}

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

    let aplay: ChildProcess | null = null;
    const ensureAplay = () => {
        if (!aplay) {
            aplay = startAplay(SAMPLE_RATE);
            aplay.on("close", () => (aplay = null));
            aplay.on("error", () => (aplay = null));
        }
    };

    let micGate = false;
    const gateFor = (ms: number) => {
        micGate = true;
        setTimeout(() => (micGate = false), ms);
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

    await session.connect({ apiKey: OPENAI_API_KEY });

    // --- IN (mic -> agent) via Pulse echo-cancel source ---
    const rec = startPulseCapture(PULSE_SOURCE, SAMPLE_RATE, 1);

    // Push mic bytes to the session as they arrive
    rec.stdout.on("data", (chunk: Buffer) => {
        if (micGate) return; // drop during the brief gate window
        // You can send any chunk size; the SDK buffers on its side.
        session.sendAudio(
            chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
        );
    });
}

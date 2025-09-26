// converse.ts - Updated with mic pausing
import { spawn, ChildProcess } from 'child_process';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { config } from "dotenv";

config();

const SAMPLE_RATE = 16000;
const PLAYBACK_RATE = 24000;
const PULSE_SOURCE = "echocancel_source";  // Use default source (no echo cancel needed)
const PULSE_SINK = "default";
const MODEL = "gpt-realtime-2025-08-28";
const VAD_THRESHOLD = 0.7;
const SILENCE_MS = 1000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY");

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

function startAplay(rate: number): ChildProcess {
    const p = spawn("aplay", [
        "-q", "-D", PULSE_SINK, "-f", "S16_LE", "-c", "1", "-r", String(rate), "-t", "raw",
    ], { stdio: ["pipe", "ignore", "ignore"] });
    return p;
}

export async function converse(): Promise<void> {
    const agent = new RealtimeAgent({
        name: "Assistant",
        instructions: "You are  an english-speaking helpful voice assistant. Be friendly and concise. Most of your responses should just be 1-2 sentences at most.",
    });

    const session = new RealtimeSession(agent, {
        transport: "websocket",
        model: MODEL,
        config: {
            instructions: "You are an english-speaking helpful voice assistant. Be friendly and concise. Most of your responses should just be 1-2 sentences at most.",
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
                    format: "pcm16",
                },
            },
        },
    });

    let aplay: ChildProcess | null = null;
    let conversationTimeout: NodeJS.Timeout | null = null;
    let shouldExit = false;
    let micPaused = false;  // Flag to pause mic during agent speech

    const ensureAplay = () => {
        if (!aplay) {
            aplay = startAplay(PLAYBACK_RATE);

            aplay.on("close", () => {
                console.log("Aplay finished - resuming mic");
                aplay = null;
                micPaused = false;
                startConversationTimeout();
            });

            aplay.on("error", () => {
                aplay = null;
                micPaused = false;
            });
        }
    };
    const clearConversationTimeout = () => {
        if (conversationTimeout) {
            clearTimeout(conversationTimeout);
            conversationTimeout = null;
        }
    };

    const startConversationTimeout = () => {
        clearConversationTimeout();
        conversationTimeout = setTimeout(() => {
            console.log("No speech for 5 seconds - ending conversation");
            shouldExit = true;
            session.close();
        }, 5000);
    };

    session.on("audio", (evt) => {
        ensureAplay();
        if (aplay?.stdin?.writable && evt.data?.byteLength) {
            aplay.stdin.write(Buffer.from(new Uint8Array(evt.data)));
        }
    });

    session.on("transport_event", (ev) => {
        switch (ev.type) {
            case "input_audio_buffer.speech_started":
                console.log("User speaking...");
                clearConversationTimeout();
                break;

            case "response.audio_transcript.delta":
                if (!micPaused) {
                    micPaused = true;
                    console.log("Mic paused");
                }
                break;

            case "response.output_audio.done":
                console.log("Audio generation complete");
                // Close aplay to flush buffer and trigger the 'close' event
                if (aplay?.stdin) {
                    aplay.stdin.end();
                }
                break;
        }
    });
    session.on("error", (err) => {
        console.error("Session error:", err);
        shouldExit = true;
    });

    await session.connect({ apiKey: OPENAI_API_KEY });
    console.log("Connected to OpenAI");

    const rec = startPulseCapture(PULSE_SOURCE, SAMPLE_RATE, 1);
    console.log("Listening for user input");

    rec.stdout.on("data", (chunk: Buffer) => {
        if (shouldExit || micPaused) return;  // Skip audio when mic is paused
        session.sendAudio(
            chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
        );
    });

    return new Promise((resolve) => {
        const checkExit = setInterval(() => {
            if (shouldExit) {
                clearInterval(checkExit);
                clearConversationTimeout();
                rec.kill("SIGINT");
                if (aplay?.pid) aplay.kill("SIGTERM");
                resolve();
            }
        }, 100);
    });
}
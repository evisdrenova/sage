import { spawn, ChildProcess } from 'child_process';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { config } from "dotenv";

config();

const SAMPLE_RATE = 16000;
const PLAYBACK_RATE = 24000
const PULSE_SOURCE = "echocancel_source";  // Recording input
const PULSE_SINK = "default";      // Playback output
const MODEL = "gpt-realtime-2025-08-28" //gpt-4o-realtime-preview-2024-12-17";
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
function startAplay(rate: number): ChildProcess {
    const p = spawn(
        "aplay",
        [
            "-q", "-D", PULSE_SINK, "-f", "S16_LE", "-c", "1", "-r", String(rate),
            "-t", "raw",
        ],
        { stdio: ["pipe", "ignore", "ignore"] }
    );
    p.on("data", (d) => console.debug("[aplay]", d.toString().trim()));
    return p;
}

export async function converse(): Promise<void> {

    const agent = new RealtimeAgent({
        name: "Assistant",
        instructions: "You are english speaking helpful voice assistant. Be friendly and concise. Most of your respones should just be 1-2 sentences at most.",
    });

    const session = new RealtimeSession(agent, {
        transport: "websocket",
        model: MODEL,
        config: {
            instructions: "You are an english speaking helpful voice assistant. Be friendly and concise. Most of your respones should just be 1-2 sentences at most.",
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
    })

    let aplay: ChildProcess | null = null;
    let conversationTimeout: NodeJS.Timeout | null = null;
    let shouldExit = false;

    const ensureAplay = () => {
        if (!aplay) {
            aplay = startAplay(PLAYBACK_RATE);
            aplay.on("close", () => (aplay = null));
            aplay.on("error", () => (aplay = null));
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
            console.log("⏱No speech for 5 seconds - ending conversation");
            shouldExit = true;
            session.close();
        }, 5000);
    };


    // triggered when there is new audio ready to play to the user
    session.on("audio", (evt) => {
        const size = evt.data?.byteLength ?? 0;
        ensureAplay();
        if (aplay?.stdin?.writable && size > 0) {
            const buf = Buffer.from(new Uint8Array(evt.data));
            aplay.stdin.write(buf);
        }
    });

    // raw transport events
    session.on("transport_event", (ev) => {
        switch (ev.type) {
            case "input_audio_buffer.speech_started":
                console.log("🎤 User speaking...");
                clearConversationTimeout();
                break;

            case "response.audio_transcript.delta":
                // Agent is generating speech
                break;

            case "response.output_audio.done":
                console.log("🔊 Agent finished speaking");
                break;

            case "response.done":
                console.log("✅ Response complete - starting 5s timeout");
                startConversationTimeout();
                break;

            case "conversation.item.truncated":
                // User interrupted the agent
                console.log("⚡ User interrupted");
                clearConversationTimeout();
                break;
        }
    });

    session.on("error", (err) => {
        console.error("❌ Session error:", err);
        shouldExit = true;
    });

    await session.connect({ apiKey: OPENAI_API_KEY });
    console.log("Connected to OpenAI");

    const rec = startPulseCapture(PULSE_SOURCE, SAMPLE_RATE, 1);
    console.log("Parec started for conversation");

    // rec.stdout.on("data", (chunk: Buffer) => {
    //     if (shouldExit) return;

    //     // Convert float32le to int16le
    //     const float32Array = new Float32Array(
    //         chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
    //     );
    //     const int16Array = new Int16Array(float32Array.length);

    //     for (let i = 0; i < float32Array.length; i++) {
    //         const val = Math.max(-1, Math.min(1, float32Array[i] ?? 0));
    //         int16Array[i] = val * 32767;
    //     }

    //     session.sendAudio(int16Array.buffer);
    // });

    rec.stdout.on("data", (chunk: Buffer) => {
        if (shouldExit) return;
        session.sendAudio(
            chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
        );
    });

    // Wait for conversation to end
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

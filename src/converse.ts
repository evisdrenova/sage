import { RealtimeSession } from '@openai/agents/realtime';
import { spawn, ChildProcess } from 'child_process';
import { config } from "dotenv";


config();

const SAMPLE_RATE = 16000;
const PLAYBACK_RATE = 24000;
const PULSE_SOURCE = "echocancel_source";
const PULSE_SINK = "default";

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

export async function converse(session: RealtimeSession): Promise<void> {
    let aplay: ChildProcess | null = null;
    let rec: ChildProcess | null = null;
    let conversationTimeout: NodeJS.Timeout | null = null;
    let shouldExit = false;
    let isAgentSpeaking = false;

    const stopMic = () => {
        if (rec) {
            console.log("Stopping microphone");
            rec.kill("SIGINT");
            rec = null;
        }
    };

    const startMic = () => {
        if (!rec && !shouldExit && !isAgentSpeaking) {
            console.log("Starting microphone");
            rec = startPulseCapture(PULSE_SOURCE, SAMPLE_RATE, 1);
            rec.stdout?.on("data", handleMicData);
        }
    };

    const ensureAplay = () => {
        if (!aplay) {
            aplay = startAplay(PLAYBACK_RATE);

            aplay.on("close", () => {
                console.log("Playback finished");
                aplay = null;
                isAgentSpeaking = false;

                // Restart mic after playback is complete
                startMic();
                startConversationTimeout();
            });

            aplay.on("error", () => {
                console.log("Playback error");
                aplay = null;
                isAgentSpeaking = false;
                startMic();
            });
        }
    };

    const handleMicData = (chunk: Buffer) => {
        // Don't send audio if we're exiting or agent is speaking
        if (shouldExit || isAgentSpeaking) {
            return;
        }

        session.sendAudio(
            chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
        );
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

    // Audio event - first audio from agent means they're speaking
    session.on("audio", (evt) => {
        // Kill mic immediately when first audio arrives
        if (!isAgentSpeaking) {
            console.log("Agent audio started - stopping mic");
            isAgentSpeaking = true;
            stopMic();
        }

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

            case "input_audio_buffer.speech_stopped":
                console.log("User stopped speaking");
                break;

            case "conversation.item.truncated":
                console.log("User interrupted the agent");
                clearConversationTimeout();
                // Stop any ongoing playback when user interrupts
                if (aplay?.stdin) {
                    aplay.stdin.end();
                }
                break;

            case "response.created":
                // Response is being created - prepare to stop mic
                console.log("Response created");
                clearConversationTimeout();
                break;

            case "response.output_item.added":
                // Agent is preparing audio output
                if (!isAgentSpeaking) {
                    console.log("Agent preparing audio output - stopping mic");
                    isAgentSpeaking = true;
                    stopMic();
                }
                break;

            case "response.output_audio_transcript.delta":
                // Agent is speaking - ensure mic is off
                if (!isAgentSpeaking) {
                    console.log("Agent audio transcript delta - stopping mic");
                    isAgentSpeaking = true;
                    stopMic();
                }
                break;

            case "response.output_audio_transcript.done":
                console.log("Agent audio transcript done");
                break;

            case "response.output_audio.delta":
                // Audio chunks being sent - ensure mic is off
                if (!isAgentSpeaking) {
                    console.log("Agent audio delta - stopping mic");
                    isAgentSpeaking = true;
                    stopMic();
                }
                break;

            case "response.output_audio.done":
                console.log("Agent audio output done");
                break;

            case "response.output_item.done":
                console.log("Output item done");
                // Close aplay to flush buffer when output is complete
                if (aplay?.stdin) {
                    aplay.stdin.end();
                }
                break;


            case "response.done":
                console.log("Response done");
                // Ensure playback ends if not already ended
                if (aplay?.stdin) {
                    aplay.stdin.end();
                }
                break;

            case "error":
                console.error("Transport error:", ev);
                break;
        }
    });

    session.on("error", (err) => {
        console.error("Session error:", err);
        shouldExit = true;
    });

    await session.connect({ apiKey: OPENAI_API_KEY });
    console.log("Connected to OpenAI");

    startMic();
    console.log("Listening for user input");

    startConversationTimeout();

    return new Promise((resolve) => {
        const checkExit = setInterval(() => {
            if (shouldExit) {
                clearInterval(checkExit);
                clearConversationTimeout();
                stopMic();
                if (aplay?.pid) aplay.kill("SIGTERM");
                resolve();
            }
        }, 100);
    });
}
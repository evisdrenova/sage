// import { PvRecorder } from "@picovoice/pvrecorder-node";
// import { sleep } from "./utils";
// import { spawn, ChildProcess } from 'child_process';
// import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
// import { config } from "dotenv";

// config();

// const SAMPLE_RATE = 24000;
// const ALSA_DEVICE = "plughw:4,0"
// const MODEL = "gpt-4o-realtime-preview-2024-12-17";
// const VAD_THRESHOLD = 0.7
// const SILENCE_MS = 1000
// const FRAME_LENGTH = 512;
// const DEVICE_INDEX = 3;


// const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
// if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY");

// //the turn detection is nto working well like i can't interrupt it
// // its sendign the event taht the agent is done talking even though it's still going
// // i can't just pause the microphone incase i need to interrupt it but it seems liek it's catching it's own playback

// export async function converse(): Promise<void> {
//     const agent = new RealtimeAgent({
//         name: "Assistant",
//         instructions: "You are a helpful voice assistant. Be friendly and concise. Most of your respones should just be 1-2 sentences at most.",
//     });

//     const session = new RealtimeSession(agent, {
//         transport: "websocket",
//         model: MODEL,
//         config: {
//             instructions: "You are a helpful voice assistant. Be friendly and concise. Most of your respones should just be 1-2 sentences at most.",
//             outputModalities: ["audio"],
//             audio: {
//                 input: {
//                     turnDetection: {
//                         type: "server_vad",
//                         threshold: VAD_THRESHOLD,
//                         prefix_padding_ms: 300,
//                         silence_duration_ms: SILENCE_MS,
//                     },
//                 },
//                 output: {
//                     voice: 'alloy',
//                     format: "pcm16"
//                 },
//             },
//         },
//     })
//     let isPlayingAudio = false;

//     // ---- audio OUT (agent -> ALSA) ----
//     let aplay: ChildProcess | null = null;

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
//             console.log("🔊 Audio playback finished");
//             aplay = null;
//             isPlayingAudio = false;
//         });

//         aplay.on("error", (err) => {
//             console.error("aplay error:", err);
//             aplay = null;
//             isPlayingAudio = false;
//         });
//     };

//     let framesSent = 0;
//     let bytesSent = 0;
//     let lastRxAt = Date.now();
//     let audioReceived = false;
//     let micPaused = false;

//     // triggered when there is new audio ready to play to the user
//     session.on("audio", (evt) => {
//         const size = evt.data?.byteLength ?? 0;
//         lastRxAt = Date.now();
//         audioReceived = true;

//         ensureAplay();
//         if (aplay?.stdin?.writable && size > 0) {
//             const buf = Buffer.from(new Uint8Array(evt.data));
//             aplay.stdin.write(buf);
//         }
//     });

//     session.on("audio_start", (evt) => {
//         console.log("🔊 Agent is starting to speak...");
//         isPlayingAudio = true;
//         micPaused = true;
//     });

//     session.on("agent_end", (evt) => {
//         console.log("✅ Agent finished response");
//         // Add a small delay before resuming mic to let audio finish
//         setTimeout(() => {
//             micPaused = false;
//             console.log("🎙️ Microphone resumed");
//         }, 500); // 500ms delay
//         isPlayingAudio = false;
//     });


//     session.on("error", (evt) => {
//         console.log("there was an error", evt)
//     });


//     session.on("agent_end", (evt) => {
//         console.log("the agent is done ")
//     })


//     let active = true;

//     session.on("error", (err) => {
//         console.error("❌ Session error:", err);
//         active = false;
//     });

//     const hb = setInterval(() => {
//         console.log(`❤️ active=${active} framesSent=${framesSent} bytesSent=${bytesSent} audioRx=${audioReceived}`);

//         // Warn if no audio back in 10s
//         if (Date.now() - lastRxAt > 10000) {
//             console.warn("⏳ no audio/text from agent for 10s — still listening…");
//         }
//     }, 5000);

//     const mic = new PvRecorder(FRAME_LENGTH, DEVICE_INDEX);

//     try {
//         // Connect the session
//         await session.connect({ apiKey: OPENAI_API_KEY });

//         // Start mic
//         await mic.start();
//         console.log("Mic started — speak when ready");

//         // Give a moment for connection to stabilize
//         await sleep(1000);

//         // Main loop
//         while (active) {
//             if (!mic.isRecording || micPaused) {
//                 await sleep(10);
//                 continue;
//             }

//             const frame = await mic.read();
//             const abuf = converAudioToArrayBuffer(frame);
//             session.sendAudio(abuf);

//             framesSent++; // Track frames for debugging
//             bytesSent += abuf.byteLength;

//             await sleep(5);
//         }

//     } catch (error) {
//         console.error("💥 Error in conversation:", error);
//     } finally {
//         console.log("🧹 Cleaning up...");
//         clearInterval(hb);
//         await cleanUpStream(mic, aplay, session)
//     }
// }




// function converAudioToArrayBuffer(int16Array: Int16Array): ArrayBuffer {
//     const buffer = new ArrayBuffer(int16Array.length * 2);
//     const view = new Int16Array(buffer);
//     view.set(int16Array);
//     return buffer;
// }


// async function cleanUpStream(
//     mic: PvRecorder | null,
//     aplay: ChildProcess | null,
//     session: RealtimeSession<unknown>
// ) {

//     if (mic) {
//         try {
//             await mic.stop();
//             mic.release();
//             console.log("🎙️ Mic stopped and released");
//         } catch (err) {
//             console.error("Error stopping mic:", err);
//         }
//     }

//     if (aplay) {
//         try {
//             if (aplay.stdin?.writable) {
//                 aplay.stdin.end();
//                 console.log("🔊 aplay stdin ended");
//             }
//         } catch (err) {
//             console.error("Error ending aplay stdin:", err);
//         }

//         try {
//             if (aplay.pid) {
//                 aplay.kill("SIGTERM");
//                 console.log("🔊 aplay process killed");
//             }
//         } catch (err) {
//             console.error("Error killing aplay:", err);
//         }
//     }

//     try {
//         if (session) {
//             await session.close();
//             console.log("🔌 Session disconnected");
//         }
//     } catch (err) {
//         console.error("Error disconnecting session:", err);
//     }
// }


// updated but issue with the input now not being captured, somethign with the source


import { PvRecorder } from "@picovoice/pvrecorder-node";
import { spawn, ChildProcess } from 'child_process';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { config } from "dotenv";

config();

const SAMPLE_RATE = 24000;               // keep this consistent end-to-end
const PULSE_SOURCE = "echocancel_source";
const PULSE_SINK = "default";            // routes to echocancel_sink since you set it default
const MODEL = "gpt-4o-realtime-preview-2024-12-17";
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

function startAplay(rate = SAMPLE_RATE): ChildProcess {
    const p = spawn(
        "aplay",
        [
            "-q",
            "-D",
            PULSE_SINK,      // "default" -> Pulse default sink (your echocancel_sink)
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
    // p.stderr?.on("data", (d) => console.debug("[aplay]", d.toString().trim()));
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
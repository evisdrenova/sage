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



function tightArrayBufferOf(view: ArrayBufferView): ArrayBuffer {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer; // tightly sized, byteOffset 0
}

async function converseWithRealtime(recorder: PvRecorder, {
    vadThreshold = 0.5,
    silenceMs = 600,
    sessionIdleMs = 12000,
} = {}): Promise<void> {
    const agent = new RealtimeAgent({
        name: "Greeter",
        instructions:
            "You are a helpful voice assistant. Be brief, friendly, and respond clearly.",
    });

    const session = new RealtimeSession(agent, {
        transport: "websocket",
        model: MODEL,
        config: {
            audio: {
                input: {
                    turnDetection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800, prefix_padding_ms: 300 },
                }
            },
            outputAudioFormat: "pcm16",
            voice: "alloy",
            modalities: ["audio", "text"],
            instructions: "You are a helpful voice assistant. Keep answers short.",
        }
    });

    // 2) Hook up audio OUT (PCM16 from the model) -> ALSA via aplay
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

        aplay.on("close", () => { aplay = null; });
        aplay.on("error", () => { aplay = null; });
    };

    session.on("audio", (evt) => {
        // evt.data is an ArrayBuffer of PCM16 mono @ 16kHz
        ensureAplay();
        if (!aplay?.stdin?.writable) return;
        const buf = Buffer.from(new Uint8Array(evt.data)); // ArrayBuffer -> Buffer
        aplay.stdin.write(buf);
    });

    // (Optional) Text deltas if you want to log them
    session.on("text", (evt:) => {
        if (evt.delta) process.stdout.write(evt.delta);
        if (evt.done) process.stdout.write("\n");
    });

    // 3) Connect (SDK handles session creation & configuration)
    await session.connect({ apiKey: OPENAI_API_KEY });

    // Optionally tweak session params (server VAD for turn-taking, voice, etc.)
    await session.update({
        turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800, prefix_padding_ms: 300 },
        output_audio_format: "pcm16",
        voice: "alloy",
        modalities: ["audio", "text"],
        instructions: "You are a helpful voice assistant. Keep answers short.",
    });

    // 4) Start mic capture (PvRecorder -> sendAudio)
    const mic = new PvRecorder(FRAME_LENGTH, MIC_DEVICE);
    await mic.start();
    console.log("🎙️ mic started — speak when ready");

    // Open an initial response turn (the model will listen for audio)
    await session.createResponse({ modalities: ["audio", "text"] });

    // Main loop: read mic frames, send to session
    try {
        while (session.isConnected()) {
            if (!mic.isRecording) { await sleep(10); continue; }
            const frame = await mic.read(); // Int16Array length FRAME_LENGTH
            const ab = tightArrayBufferOf(frame); // exact ArrayBuffer for this frame
            session.sendAudio(ab); // SDK handles framing & backpressure internally
        }
    } finally {
        try { await mic.stop(); mic.release(); } catch { }
        try { if (aplay?.stdin) aplay.stdin.end(); } catch { }
        try { if (aplay && aplay.pid) aplay.kill("SIGINT"); } catch { }
        await session.disconnect();
    }


}


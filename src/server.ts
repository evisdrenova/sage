import { Porcupine, BuiltinKeyword } from "@picovoice/porcupine-node";
import { PvRecorder } from "@picovoice/pvrecorder-node";
import { config } from "dotenv";
import { answerAndSpeakRealtime, transcribeOnceFromRecorder } from "./speak";
import { sleep } from "./utils";
import { SessionTimer } from "./timer";

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

                    console.log("🔵 Wake word detected!");
                    mode = Mode.Converse
                    await converse(recorder);
                    mode = Mode.Wake
                }
            }
        }
    } catch (err) {
        console.error("❌ Error:", err);
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

        // If audio is playing, just wait. Don't do ANYTHING else.
        if (IS_PLAYING_AUDIO) {
            console.log("🔇 Audio is playing, waiting...");
            sessionTimer.pause();

            while (IS_PLAYING_AUDIO) {
                await sleep(100);
            }

            // Audio finished, wait a bit more for echoes to die down
            console.log("⏳ Audio finished, waiting 2 seconds for echoes...");
            await sleep(2000);

            sessionTimer.resume();
        }

        console.log(`👂 Ready to listen... (${sessionTimer.getRemainingMs()}ms remaining)`);

        // Only transcribe if we're NOT playing audio
        if (IS_PLAYING_AUDIO) {
            console.log("🔇 Audio started during setup, skipping transcription");
            continue;
        }

        const transcript = await transcribeOnceFromRecorder(recorder, IS_PLAYING_AUDIO, {
            silenceMs: turnSilenceMs,
            maxOverallMs: Math.min(sessionTimer.getRemainingMs(), sessionIdleMs),
        });

        if (!transcript) {
            console.log("🔇 No transcript - session ending");
            break;
        }

        sessionTimer.reset();

        // Set audio state and play response
        sessionTimer.pause();
        IS_PLAYING_AUDIO = true;
        console.log("🔊 Audio playback started");
        recorder.stop()

        try {
            await answerAndSpeakRealtime(transcript);
        } finally {
            IS_PLAYING_AUDIO = false;
            console.log("🔇 Audio playback stopped");
            sessionTimer.resume();
            recorder.start()
        }
    }

    console.log("↩️ Returning to wake mode");
}

export function setAudioPlayingState(playing: boolean) {
    IS_PLAYING_AUDIO = playing;
    console.log(playing ? "🔊 Audio playback started" : "🔇 Audio playback stopped");
}

if (require.main === module) {
    start().catch((e) => {
        console.error("❌ Startup failed:", e);
        process.exit(1);
    });
}

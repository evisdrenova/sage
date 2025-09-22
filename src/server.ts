import { Porcupine, BuiltinKeyword } from "@picovoice/porcupine-node";
import { PvRecorder } from "@picovoice/pvrecorder-node";
import { config } from "dotenv";
import { converse } from "./converse";

config();

const FRAME_LENGTH = 512;
const DEVICE_INDEX = 3;
const SENSITIVITY = 0.5;
const REFRACTORY_MS = 750;
const KEYWORD = BuiltinKeyword.COMPUTER;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY");

export async function start() {
    const ACCESS_KEY = process.env.PICOVOICE_ACCESS_KEY;
    if (!ACCESS_KEY) throw new Error("PICOVOICE_ACCESS_KEY not set in environment");

    let porcupine: Porcupine | null = new Porcupine(ACCESS_KEY, [KEYWORD], [SENSITIVITY]);
    let recorder: PvRecorder | null = new PvRecorder(FRAME_LENGTH, DEVICE_INDEX);
    let shuttingDown = false;
    let lastDetect = 0;

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
        await recorder.start();
        console.log("Ready! Listening for wake word ...");

        while (recorder.isRecording) {
            const frame = await recorder.read();
            const idx = porcupine.process(frame);
            if (idx >= 0) {
                const now = Date.now();
                if (now - lastDetect < REFRACTORY_MS) continue;
                lastDetect = now;

                console.log("Wake word detected!");
                await converse();

            }

        }
    } catch (err) {
        console.error("Error:", err);
        throw err;
    } finally {
        await shutdown();
    }
}


if (require.main === module) {
    start().catch((e) => {
        console.error("Startup failed:", e);
        process.exit(1);
    });
}
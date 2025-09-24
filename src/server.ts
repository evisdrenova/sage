// import { Porcupine, BuiltinKeyword } from "@picovoice/porcupine-node";
// import { PvRecorder } from "@picovoice/pvrecorder-node";
// import { config } from "dotenv";
// import { converse } from "./converse";

// config();

// const FRAME_LENGTH = 512;
// const DEVICE_INDEX = 3;
// const SENSITIVITY = 0.5;
// const REFRACTORY_MS = 750;
// const KEYWORD = BuiltinKeyword.COMPUTER;

// const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
// if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY");

// export async function start() {
//     const ACCESS_KEY = process.env.PICOVOICE_ACCESS_KEY;
//     if (!ACCESS_KEY) throw new Error("PICOVOICE_ACCESS_KEY not set in environment");

//     let porcupine: Porcupine | null = new Porcupine(ACCESS_KEY, [KEYWORD], [SENSITIVITY]);
//     let recorder: PvRecorder | null = new PvRecorder(FRAME_LENGTH, DEVICE_INDEX);
//     let shuttingDown = false;
//     let lastDetect = 0;

//     const shutdown = async () => {
//         if (shuttingDown) return;
//         shuttingDown = true;
//         try {
//             if (recorder) {
//                 try { recorder.stop(); } catch { }
//                 try { recorder.release(); } catch { }
//             }
//             if (porcupine) {
//                 try { porcupine.release(); } catch { }
//             }
//         } finally {
//             process.exit(0);
//         }
//     };

//     process.on("SIGINT", shutdown);
//     process.on("SIGTERM", shutdown);

//     try {
//         await recorder.start();
//         console.log("Ready! Listening for wake word ...");

//         while (recorder.isRecording) {
//             const frame = await recorder.read();
//             const idx = porcupine.process(frame);
//             if (idx >= 0) {
//                 const now = Date.now();
//                 if (now - lastDetect < REFRACTORY_MS) continue;
//                 lastDetect = now;

//                 console.log("Wake word detected!");
//                 await converse();

//             }

//         }
//     } catch (err) {
//         console.error("Error:", err);
//         throw err;
//     } finally {
//         await shutdown();
//     }
// }


// if (require.main === module) {
//     start().catch((e) => {
//         console.error("Startup failed:", e);
//         process.exit(1);
//     });
// }


// src/server.ts (wake-word listener using PulseAudio + Porcupine)
import { Porcupine, BuiltinKeyword } from "@picovoice/porcupine-node";
import { spawn, ChildProcess } from "child_process";
import { config } from "dotenv";
import { converse } from "./converse"; // your existing function

config();

const FRAME_LENGTH = 512;              // Porcupine expects 512 samples @ 16kHz
const SAMPLE_RATE = 16000;
const KEYWORD = BuiltinKeyword.COMPUTER;
const SENSITIVITY = 0.5;
const REFRACTORY_MS = 750;

// Pulse devices
const PULSE_SOURCE = process.env.PULSE_SOURCE || "echocancel_source"; // or any `pactl list short sources` name

function startParec(source = PULSE_SOURCE): ChildProcess {
    const p = spawn("parec", [
        `--device=${source}`,
        "--raw",
        "--format=s16le",
        `--rate=${SAMPLE_RATE}`,
        "--channels=1",
    ]);
    p.stderr.on("data", (d) => {
        const s = d.toString().trim();
        if (s) console.debug("[parec]", s);
    });
    return p;
}

export async function start() {
    const ACCESS_KEY = process.env.PICOVOICE_ACCESS_KEY;
    if (!ACCESS_KEY) throw new Error("PICOVOICE_ACCESS_KEY not set in environment");

    let porcupine: Porcupine | null = null;
    let rec: ChildProcess | null = null;
    let shuttingDown = false;
    let lastDetect = 0;

    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        try {
            if (rec && rec.pid) try { rec.kill("SIGINT"); } catch { }
            if (porcupine) try { porcupine.release(); } catch { }
        } finally {
            process.exit(0);
        }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
        porcupine = new Porcupine(ACCESS_KEY, [KEYWORD], [SENSITIVITY]);

        // Start Pulse recorder
        rec = startParec();
        console.log(`Ready! Listening for wake word via Pulse source "${PULSE_SOURCE}" ...`);

        // Accumulate bytes until we have one Porcupine frame (512 samples * 2 bytes)
        let buf = Buffer.alloc(0);
        const BYTES_PER_FRAME = FRAME_LENGTH * 2;

        rec.stdout?.on("data", async (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            while (buf.length >= BYTES_PER_FRAME) {
                const frameBytes = buf.subarray(0, BYTES_PER_FRAME);
                buf = buf.subarray(BYTES_PER_FRAME);

                // Convert bytes -> Int16Array without copying more than needed
                // Node Buffer -> Uint8Array -> ArrayBuffer -> Int16Array (LE)
                const ab = frameBytes.buffer.slice(
                    frameBytes.byteOffset,
                    frameBytes.byteOffset + frameBytes.byteLength
                );
                const frame = new Int16Array(ab);

                const idx = porcupine!.process(frame);
                if (idx >= 0) {
                    const now = Date.now();
                    if (now - lastDetect < REFRACTORY_MS) continue;
                    lastDetect = now;

                    console.log("🔵 Wake word detected!");
                    // Stop recording while we converse
                    try { if (rec?.pid) rec.kill("SIGINT"); } catch { }
                    rec = null;
                    buf = Buffer.alloc(0);

                    try {
                        await converse(); // your existing conversation function (now using Pulse)
                    } catch (e) {
                        console.error("converse() error:", e);
                    }

                    // After conversation, restart recorder and continue wake mode
                    rec = startParec();
                    console.log("↩ Back to wake mode");
                }
            }
        });

        rec.on("close", (code) => {
            if (!shuttingDown) {
                console.warn(`parec exited (${code}); restarting in 500ms...`);
                setTimeout(() => { if (!shuttingDown) rec = startParec(); }, 500);
            }
        });

    } catch (err) {
        console.error("Error:", err);
        throw err;
    }
}

if (require.main === module) {
    start().catch((e) => {
        console.error("Startup failed:", e);
        process.exit(1);
    });
}

import { Porcupine, BuiltinKeyword } from "@picovoice/porcupine-node";
import { spawn, ChildProcess } from "child_process";
import { config } from "dotenv";
import { converse } from "./converse";

config();

const FRAME_LENGTH = 512; // 512 samples @ 16kHz
const SAMPLE_RATE = 16000;
const KEYWORD = BuiltinKeyword.COMPUTER;
const SENSITIVITY = 0.5;
const REFRACTORY_MS = 750;

const PULSE_SOURCE = "echocancel_source";

// spawns a parec (pulseaudio recorder) process to stream raw audio data (16-bit, 16KHZ, mono) from microphone 
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
    let recorder: ChildProcess | null = null;
    let shuttingDown = false;
    let lastDetect = 0;
    let intentionalStop = false;

    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log("received a SIGINT or SIGTERM, shutting down")
        try {
            if (recorder && recorder.pid) try { recorder.kill("SIGINT"); } catch { }
            if (porcupine) try { porcupine.release(); } catch { }
        } finally {
            process.exit(0);
        }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
        porcupine = new Porcupine(ACCESS_KEY, [KEYWORD], [SENSITIVITY]);

        recorder = startParec();
        console.log(`Ready! Listening for wake word ...`);

        // Accumulate bytes until we have one Porcupine frame (512 samples * 2 bytes = 1024 bytes)
        let buf = Buffer.alloc(0);
        const BYTES_PER_FRAME = FRAME_LENGTH * 2;

        // listens for audio chunks from parec process
        recorder.stdout?.on("data", async (chunk: Buffer) => {
            // chunk into buffer since audio comes in variable sizes
            buf = Buffer.concat([buf, chunk]);
            // keep processing frames until buffer is too small
            while (buf.length >= BYTES_PER_FRAME) {
                // once we have BYTES_PER_FRAME bytes, extract a full frame
                const frameBytes = buf.subarray(0, BYTES_PER_FRAME);
                // remove the processed bytes
                buf = buf.subarray(BYTES_PER_FRAME);

                // Converts the raw bytes into the Int16Array format that Porcupine expects
                // This represents 512 audio samples as 16-bit signed integers
                const ab = frameBytes.buffer.slice(
                    frameBytes.byteOffset,
                    frameBytes.byteOffset + frameBytes.byteLength
                );

                const frame = new Int16Array(ab);

                const idx = porcupine!.process(frame);
                // returns index of observed key word, so if there is an index then it identified the wake word
                if (idx >= 0) {
                    const now = Date.now();
                    // ignores multiple wake words within a short amount of time from triggering
                    if (now - lastDetect < REFRACTORY_MS) continue;
                    lastDetect = now;

                    console.log("Wake word detected!");

                    // Stop recording while we converse
                    intentionalStop = true; // Mark this as intentional stop
                    try { if (recorder?.pid) recorder.kill("SIGINT"); } catch { }
                    recorder = null;
                    // clean buffer
                    buf = Buffer.alloc(0);

                    try {
                        console.log("before converse")
                        await converse();
                        console.log("after converse")
                    } catch (e) {
                        console.error("converse() error:", e);
                    }

                    recorder = startParec();
                    console.log("Back to listening for wake word");
                }
            }
        });

        recorder.on("close", (code) => {
            if (!shuttingDown && !intentionalStop) {
                console.warn(`parec exited (${code}); restarting in 500ms...`);
                setTimeout(() => {
                    if (!shuttingDown) recorder = startParec();
                }, 500);
            }
            intentionalStop = false;
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
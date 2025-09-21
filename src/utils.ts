export function msFromPcmBytes(bytes: number, sr: number) {
    const samples = bytes / 2;            // 16-bit mono
    return (samples / sr) * 1000;
}

export type Int16Frame = Int16Array | number[];

export function frameToBase64PCM16LE(frame: Int16Frame): string {
    if (frame instanceof Int16Array) {
        return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString("base64");
    }
    const buf = Buffer.allocUnsafe(frame.length * 2);
    for (let i = 0; i < frame.length; i++) buf.writeInt16LE(frame[i] ?? 0, i * 2);
    return buf.toString("base64");
}


export function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
}


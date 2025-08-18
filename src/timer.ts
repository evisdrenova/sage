// handles the timer during transcription and audio to make sure we don't freeze

export class SessionTimer {
    private remainingMs: number;
    private isPaused: boolean = false;
    private lastCheckTime: number;
    private sessionIdleMs: number = 12000;

    constructor(initialMs: number) {
        this.remainingMs = initialMs;
        this.lastCheckTime = Date.now();
    }

    pause() {
        if (!this.isPaused) {
            this.updateRemaining();
            this.isPaused = true;
            console.log(`⏸Session timer paused (${this.remainingMs}ms remaining)`);
        }
    }

    resume() {
        if (this.isPaused) {
            this.isPaused = false;
            this.lastCheckTime = Date.now();
            console.log(`▶Session timer resumed (${this.remainingMs}ms remaining)`);
        }
    }

    reset() {
        this.remainingMs = this.sessionIdleMs;
        this.lastCheckTime = Date.now();
        console.log("🔄 Session timer reset");
    }

    private updateRemaining() {
        if (!this.isPaused) {
            const elapsed = Date.now() - this.lastCheckTime;
            this.remainingMs = Math.max(0, this.remainingMs - elapsed);
            this.lastCheckTime = Date.now();
        }
    }

    isExpired(): boolean {
        this.updateRemaining();
        return this.remainingMs <= 0;
    }

    getRemainingMs(): number {
        this.updateRemaining();
        return this.remainingMs;
    }
}
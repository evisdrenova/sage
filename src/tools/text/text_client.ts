import axios, { AxiosError, AxiosInstance } from 'axios';
import * as fs from "node:fs";
import * as crypto from "node:crypto";

type SendMethod = "auto" | "private-api" | "apple-script";

export interface BlueBubblesOptions {
    baseUrl?: string;
    password?: string;
    defaultMethod?: SendMethod;
    timeoutMs?: number;
    contactsPath?: string;
}

export interface SendTextArgs {
    chatGuid: string;
    message: string;
    method: SendMethod
    tempGuid: string;
}

export interface BlueBubblesResponse {
    status?: number;
    message?: string;
    data?: any;
    error?: any;
}


export class BlueBubblesMessenger {
    private baseUrl: string;
    private password: string;
    private defaultMethod: SendMethod;
    private timeoutMs: number;
    private http: AxiosInstance;

    constructor(opts: BlueBubblesOptions = {}) {
        const BLUEBUBBLES_URL = process.env.BLUEBUBBLES_URL || "";
        const BLUEBUBBLES_PASSWORD = process.env.BLUEBUBBLES_PASSWORD || "";
        this.baseUrl = (opts.baseUrl || BLUEBUBBLES_URL).replace(/\/$/, "");
        this.password = opts.password || BLUEBUBBLES_PASSWORD;
        this.defaultMethod = opts.defaultMethod || "auto";
        this.timeoutMs = opts.timeoutMs ?? 10_000;

        if (!this.baseUrl) {
            throw new BlueBubblesError(
                "Missing baseUrl"
            );
        }

        if (!this.password) {
            throw new BlueBubblesError(
                "Missing password"
            );
        }

        this.http = axios.create({ baseURL: this.baseUrl, timeout: this.timeoutMs });
    }



    async sendText(args: SendTextArgs): Promise<BlueBubblesResponse> {
        const method = (args.method || this.defaultMethod);

        if (!args.chatGuid) throw new BlueBubblesError("recipient or chatGuid is required");
        if (method != "apple-script") throw new BlueBubblesError("only apple-script is supported right now");

        return await this._send(args.chatGuid, args.message, method, args.tempGuid);
    }


    private async _send(chatGuid: string, message: string, method: SendMethod, tempGuid?: string): Promise<BlueBubblesResponse> {
        const body: Record<string, any> = { message: message, method: method };
        if (chatGuid) {
            body.chatGuid = chatGuid
        } else throw new BlueBubblesError("address or chatGuid required");

        if (method === "apple-script") {
            body.tempGuid = tempGuid || this._newTempGuid();
        }

        try {
            const res = await this.http.post("/api/v1/message/text", body, {
                params: { password: this.password },
                headers: { "Content-Type": "application/json" },
            });
            console.log("res.data", res.data)
            return res.data as BlueBubblesResponse;
        } catch (e) {
            throw this._axiosToError(e);
        }
    }

    private _axiosToError(e: unknown): BlueBubblesError {
        if (isAxiosError(e)) {
            const ae = e as AxiosError<any>;
            const status = ae.response?.status;
            const details = ae.response?.data;
            const msg = details?.error?.message || details?.message || ae.message;
            return new BlueBubblesError(msg, status, details);
        }
        return new BlueBubblesError((e as any)?.message || String(e));
    }
    private _newTempGuid(): string {
        return `bb-temp-${crypto.randomUUID()}`;
    }
}


function isAxiosError(e: unknown): e is AxiosError {
    return (e as any)?.isAxiosError === true;
}


export class BlueBubblesError extends Error {
    public readonly status?: number | undefined;
    public readonly details?: unknown;

    constructor(message: string, status?: number, details?: unknown) {
        super(message);
        this.name = 'BlueBubblesError';
        this.status = status;
        this.details = details;
        Object.setPrototypeOf(this, BlueBubblesError.prototype);
    }
}
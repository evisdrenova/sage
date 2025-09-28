
import { tool } from '@openai/agents'
import { z } from 'zod';
import { config } from "dotenv";
import axios, { AxiosInstance } from 'axios';
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

type SendMethod = "auto" | "private-api" | "apple-script";

interface SendTextToolArgs {
    recipient?: string;
    chatGuid?: string;
    message: string;
    method?: SendMethod; // 'auto' | 'private-api' | 'apple-script'
};

export interface BlueBubblesResponse {
    status?: number;
    message?: string;
    [key: string]: unknown;
}


export interface BlueBubblesOptions {
    baseUrl?: string; // e.g. http://192.168.1.50:1234
    password?: string; // BlueBubbles Server password
    defaultMethod?: SendMethod; // default "auto"
    timeoutMs?: number; // default 10000
    contactsPath?: string; // optional path to JSON mapping {"Mom":"+1555..."}
}

export interface SendTextArgs {
    chatGuid: string; // the recipient's number
    message: string;
    method: SendMethod
    tempGuid: string;
}

export class BlueBubblesMessenger {
    private baseUrl: string;
    private password: string;
    private defaultMethod: SendMethod;
    private timeoutMs: number;
    private contacts: Record<string, string> = {};
    private http: AxiosInstance;



    constructor(opts: BlueBubblesOptions = {}) {
        const BLUEBUBBLES_URL = process.env.BLUEBUBBLES_URL || "";
        const BLUEBUBBLES_PASSWORD = process.env.BLUEBUBBLES_PASSWORD || "";
        this.baseUrl = (opts.baseUrl || BLUEBUBBLES_URL).replace(/\/$/, "");
        this.password = opts.password || BLUEBUBBLES_PASSWORD;
        this.defaultMethod = opts.defaultMethod || "auto";
        this.timeoutMs = opts.timeoutMs ?? 10_000;


        if (!this.baseUrl || !this.password) {
            throw new BlueBubblesError(
                "Missing baseUrl/password. Set BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD or pass options."
            );
        }


        if (opts.contactsPath) {
            try {
                if (fs.existsSync(opts.contactsPath)) {
                    const raw = fs.readFileSync(opts.contactsPath, "utf-8");
                    this.contacts = JSON.parse(raw);
                }
            } catch (_) { /* non-fatal */ }
        }


        this.http = axios.create({ baseURL: this.baseUrl, timeout: this.timeoutMs });
    }
    async sendText(args: SendTextArgs): Promise<BlueBubblesResponse> {
        const method = (args.method || this.defaultMethod);

        let address: string | undefined;
        if (!args.chatGuid) throw new BlueBubblesError("recipient or chatGuid is required");


        if (method === "apple-script") {
            if (!this._isTempGuidValidation(err)) throw err;
            return await this._send({ address, chatGuid: args.chatGuid, message: args.message, method: "apple-script", tempGuid: args.tempGuid });

        }


        // Explicit method
        return await this._send({ address, chatGuid: args.chatGuid, message: args.message, method, tempGuid: args.tempGuid });
    }

    private async _send(params: { address?: string; chatGuid?: string; message: string; method: Exclude<SendMethod, "auto">; tempGuid?: string; }): Promise<BlueBubblesResponse> {
        const body: Record<string, any> = { message: params.message, method: params.method };
        if (params.chatGuid) body.chatGuid = params.chatGuid;
        else if (params.address) body.address = params.address;
        else throw new BlueBubblesError("address or chatGuid required");


        if (params.method === "apple-script") {
            body.tempGuid = params.tempGuid || this._newTempGuid();
        }


        try {
            const res = await this.http.post("/api/v1/message/text", body, {
                params: { password: this.password },
                headers: { "Content-Type": "application/json" },
            });
            return res.data as BlueBubblesResponse;
        } catch (e) {
            throw this._axiosToError(e);
        }
    }

    private _isTempGuidValidation(err: unknown): boolean {
        const msg = String((err as any)?.message || "").toLowerCase();
        return msg.includes("tempguid") || msg.includes("temp guid");
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
}


function isAxiosError(e: unknown): e is AxiosError {
    return (e as any)?.isAxiosError === true;
}


export class BlueBubblesError extends Error {
    public status?: number;
    public details?: unknown;
    constructor(message: string, status?: number, details?: unknown) {
        super(message);
        this.name = "BlueBubblesError";
        this.status = status;
        this.details = details;
    }
}
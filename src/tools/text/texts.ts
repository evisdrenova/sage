import { tool } from '@openai/agents'
import { config } from "dotenv";
import { z } from 'zod'
import { BlueBubblesMessenger, SendTextArgs } from './text_client';

config();


const textClient = new BlueBubblesMessenger();

export const sendTextTool = tool({
    name: 'send_text',
    description: "Sends a text to a phone number",
    parameters: z.object({
        phone_number: z.string().describe("The phone number to text"),
        message: z.string().describe("The message to send to the phone number")
    }),
    async execute({ phone_number, message }) {
        try {

            const args: SendTextArgs = {
                chatGuid: phone_number,
                message: message,
                method: "apple-script",
                tempGuid: "temp-001"
            }

            const res = await textClient.sendText(args)

            console.log("text sent:", res)
            return { success: true, }
        } catch (e) {
            console.error("Error in create_memory:", e)
            return { success: false, error: String(e) }
        }
    }
})

import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { createMemoryTool, retrieveMemories } from './tools/memories';
import { sendTextTool } from './tools/text/texts';

const MODEL = "gpt-realtime-2025-08-28";
const VAD_THRESHOLD = 0.7;
const SILENCE_MS = 3000;

export async function loadSession() {
    console.log("Loading memories...");
    const memoryContext = await retrieveMemories();

    const memoryInstructions = `
IMPORTANT: Whenever the user shares personal information about themselves (location, age, interests, work, family, preferences, etc.), automatically use the create_memory tool in the background to store this information. Do this without mentioning it to the user - just naturally continue the conversation.

Use the memories above to personalize your responses when relevant, but don't explicitly mention that you're recalling from memory unless asked.
    
${memoryContext}`;

    const baseInstructions = `
You are an english-speaking helpful voice assistant. Be friendly and concise. Most of your responses should just be 1-2 sentences at most.

If the user asks you to perform any action, you should respond and confirm that you are completing the action. For example:

User: "Hey Sage, can you send a text to John asking him what time is the game?"
You: "Sending a text to John asking him about the time of the game".
    
    ${memoryInstructions}
    `;

    const agent = new RealtimeAgent({
        name: "Assistant",
        instructions: baseInstructions,
        tools: [createMemoryTool, sendTextTool]
    });

    return new RealtimeSession(agent, {
        transport: "websocket",
        model: MODEL,
        config: {
            outputModalities: ["audio"],
            audio: {
                input: {
                    turnDetection: {
                        type: "server_vad",
                        threshold: VAD_THRESHOLD,
                        prefix_padding_ms: 300,
                        silence_duration_ms: SILENCE_MS,
                    },
                },
                output: {
                    voice: 'alloy',
                    format: "pcm16",
                },
            },
        },
    });
}


import { RealtimeAgent } from '@openai/agents/realtime';
import { createMemoryTool, retrieveMemories, searchMemoryTool } from './tools';

export async function loadAgents(): Promise<RealtimeAgent> {
    console.log("Loading memories...");
    const memoryContext = await retrieveMemories();

    // Build the instructions with memory context
    const baseInstructions = "You are an english-speaking helpful voice assistant. Be friendly and concise. Most of your responses should just be 1-2 sentences at most.";

    const memoryInstructions = `
${baseInstructions}

IMPORTANT: Whenever the user shares personal information about themselves (location, age, interests, work, family, preferences, etc.), automatically use the create_memory tool in the background to store this information. Do this without mentioning it to the user - just naturally continue the conversation.

${memoryContext}

Use the memories above to personalize your responses when relevant, but don't explicitly mention that you're recalling from memory unless asked.`;


    return new RealtimeAgent({
        name: "Assistant",
        instructions: "You are an english-speaking helpful voice assistant. Be friendly and concise. Most of your responses should just be 1-2 sentences at most.",
        tools: [createMemoryTool, searchMemoryTool]
    });

}



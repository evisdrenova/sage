import { tool } from '@openai/agents'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod';

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

export const createMemoryTool = tool({
    name: 'create_memory',
    description: "Creates a new memory and stores it in the database",
    parameters: z.object({ memory: z.string() }),
    async execute({ memory }) {
        const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

        try {
            await supabase
                .from('memories')
                .insert({ memory: memory })
        } catch (e) {
            console.log("the error:", e)
        }
    }
})



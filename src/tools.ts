import { tool } from '@openai/agents'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod';
import { config } from "dotenv";

config();

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)


export const createMemoryTool = tool({
    name: 'create_memory',
    description: "Creates a new memory and stores it in the database",
    parameters: z.object({
        memory: z.string().describe("A concise fact about the user, e.g., 'Lives in Boston', 'Birthday is March 15th', 'Has two dogs named Max and Luna', 'Works as a software engineer'"),
        category: z.string().optional().nullable().describe("Category of memory: personal, preferences, family, work, location, interests, etc.")
    }),
    async execute({ memory, category }) {
        try {
            const { data, error } = await supabase
                .from('memories')
                .insert({
                    memory: memory,
                    category: category || 'general',
                })
                .select()
                .single()

            if (error) {
                console.error("Error creating memory:", error)
                return { success: false, error: error.message }
            }

            console.log("Memory stored:", data)
            return { success: true, memory: data }
        } catch (e) {
            console.error("Error in create_memory:", e)
            return { success: false, error: String(e) }
        }
    }
})

export async function retrieveMemories(): Promise<string> {
    try {
        const { data, error } = await supabase
            .from('memories')
            .select('memory, category, created_at')
            .order('created_at', { ascending: false })
            .limit(50)

        if (error) {
            console.error("Error retrieving memories:", error)
            return ""
        }

        if (!data || data.length === 0) {
            console.log("No memories found")
            return ""
        }

        const memoriesByCategory = data.reduce((acc, mem) => {
            const cat = mem.category || 'general'
            if (!acc[cat]) acc[cat] = []
            acc[cat].push(mem.memory)
            return acc
        }, {} as Record<string, string[]>)

        let contextString = "Here's what you remember about the user:\n"

        for (const [category, mems] of Object.entries(memoriesByCategory)) {
            contextString += `\n${category.charAt(0).toUpperCase() + category.slice(1)}:\n`
            mems.forEach(m => {
                contextString += `- ${m}\n`
            })
        }

        console.log("Retrieved memories:", data.length)
        return contextString
    } catch (e) {
        console.error("Error in retrieveMemories:", e)
        return ""
    }
}

export const searchMemoryTool = tool({
    name: 'search_memory',
    description: "Search for specific memories about the user when you need to recall information",
    parameters: z.object({
        query: z.string().describe("What to search for in memories")
    }),
    async execute({ query }) {
        try {
            const { data, error } = await supabase
                .from('memories')
                .select('memory, category, created_at')
                .textSearch('memory', query)
                .limit(10)

            if (error) {
                console.error("Error searching memories:", error)
                return { success: false, results: [] }
            }

            return {
                success: true,
                results: data || []
            }
        } catch (e) {
            console.error("Error in search_memory:", e)
            return { success: false, results: [] }
        }
    }
})
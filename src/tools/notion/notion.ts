// import { tool } from '@openai/agents'
// import { config } from "dotenv";
// import { z } from 'zod'
// import { Client } from '@notionhq/client';

import { MCPServer } from "@openai/agents";

// config();

// // Initialize Notion client
// const notion = new Client({
//     auth: process.env.NOTION_API_KEY
// });

// // Store your grocery list page ID in .env as NOTION_GROCERY_LIST_PAGE_ID
// const GROCERY_LIST_PAGE_ID = process.env.NOTION_GROCERY_LIST_PAGE_ID!;

// export const notionGroceryListTool = tool({
//     name: 'add_to_grocery_list',
//     description: "Adds items to the Notion grocery list document. Can add single or multiple items.",
//     parameters: z.object({
//         items: z.array(z.string()).describe("Array of grocery items to add to the list")
//     }),
//     async execute({ items }) {
//         try {
//             // Append items to the Notion page
//             const blocks = items.map(item => ({
//                 object: 'block' as const,
//                 type: 'to_do' as const,
//                 to_do: {
//                     rich_text: [{
//                         type: 'text' as const,
//                         text: {
//                             content: item
//                         }
//                     }],
//                     checked: false
//                 }
//             }));

//             await notion.blocks.children.append({
//                 block_id: GROCERY_LIST_PAGE_ID,
//                 children: blocks
//             });

//             console.log("Items added to grocery list:", items);
//             return { 
//                 success: true, 
//                 message: `Added ${items.length} item(s) to grocery list`,
//                 items_added: items
//             };
//         } catch (e) {
//             console.error("Error adding to grocery list:", e);
//             return { 
//                 success: false, 
//                 error: String(e) 
//             };
//         }
//     }
// });


// export const notionMCP: MCPServer = {
//     type: "mcp",
//     server_label: "notion",
//     server_url: "https://apollo.composio.dev/v3/mcp/8d950084-3023-4180-ae82-421215be6955/mcp?useComposioHelperActions=true",
// }


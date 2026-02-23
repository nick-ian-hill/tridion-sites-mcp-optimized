import { GoogleGenAI, FunctionDeclaration, Content, Type, GenerateContentResponse, FunctionCallingConfigMode, ThinkingLevel } from "@google/genai";
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PlanStep } from './types.js';

const getGenAI = (): GoogleGenAI => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("Action failed: Server is not configured with a GEMINI_API_KEY.");
    }
    return new GoogleGenAI({ apiKey });
};

export interface NextStepResult {
    planSteps: PlanStep[];
    modelResponseContent: Content | null;
}

// Helper to clean Zod schemas for Gemini
const removeUnsupportedProperties = (schema: any): any => {
    if (!schema || typeof schema !== 'object') return schema;
    
    if (Array.isArray(schema)) return schema.map(removeUnsupportedProperties);

    delete schema.$schema;
    delete schema.additionalProperties;
    delete schema.title; 
    delete schema.definitions;
    delete schema.$defs;
    delete schema.$ref;

    if ('const' in schema) {
        schema.enum = [schema.const];
        delete schema.const;
    }

    if (schema.type && Array.isArray(schema.type)) {
        schema.type = schema.type.find((t: string) => t !== 'null') || schema.type[0];
    }

    if (schema.anyOf) schema.anyOf = schema.anyOf.map(removeUnsupportedProperties);
    if (schema.oneOf) schema.oneOf = schema.oneOf.map(removeUnsupportedProperties);
    if (schema.allOf) schema.allOf = schema.allOf.map(removeUnsupportedProperties);

    if (schema.properties) {
        for (const key in schema.properties) {
            schema.properties[key] = removeUnsupportedProperties(schema.properties[key]);
        }
    }

    if (schema.items) {
        schema.items = removeUnsupportedProperties(schema.items);
    }

    return schema;
};

// Converts our internal tool definitions to Gemini's expected format
const formatToolsForGemini = (tools: any[]): FunctionDeclaration[] => {
    return tools.map(tool => {
        const zodSchema = z.object(tool.input);
        let jsonSchema = zodToJsonSchema(zodSchema, {
            $refStrategy: "none"
        });
        jsonSchema = removeUnsupportedProperties(jsonSchema);
        return {
            name: tool.name,
            description: tool.description,
            parameters: jsonSchema as any
        };
    });
};

/**
 * Determines the next steps (potentially multiple parallel steps) for the agent to take.
 */
export const determineNextStep = async (
    prompt: string,
    context: any | undefined,
    history: Content[],
    allTools: any[]
): Promise<NextStepResult> => {
    const finishTool: FunctionDeclaration = {
        name: "finish",
        description: "Call this when the current request is complete. The taskConfirmation must contain ONLY what was accomplished.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                taskConfirmation: {
                    type: Type.STRING,
                    description: "State ONLY what was accomplished for the CURRENT request. Example: 'Created folder Products (tcm:5-123-2).' This is the only part the user will see."
                },
                conversationalFiller: {
                    type: Type.STRING,
                    description: "Any extra info, capability summaries, or conversational filler. This will NOT be shown to the user."
                }
            },
            required: ['taskConfirmation']
        }
    };

    const toolsForNextStep = [...formatToolsForGemini(allTools), finishTool];

    /**
     * Formats the context object into a human-readable string for the system instruction.
     * Order matters: Container (where user is browsing) comes first, then selected items, then focused item.
     */
    const formatContext = (ctx: any): string => {
        if (!ctx) return '';
        
        const parts: string[] = [];
        
        // 1. Container - Most important: where the user is currently browsing
        if (ctx.container) {
            parts.push(`Browsing in: ${ctx.container.type} "${ctx.container.title}" (${ctx.container.id})`);
        }
        
        // 2. Selected items - Items the user has explicitly selected with checkboxes
        if (ctx.selectedItems && ctx.selectedItems.length > 0) {
            if (ctx.selectedItems.length === 1) {
                const item = ctx.selectedItems[0];
                parts.push(`Selected: ${item.type} "${item.title}" (${item.id})`);
            } else {
                parts.push(`Selected Items (${ctx.selectedItems.length}):`);
                ctx.selectedItems.forEach((item: any, index: number) => {
                    parts.push(`  ${index + 1}. ${item.type} "${item.title}" (${item.id})`);
                });
            }
        }
        
        // 3. Details item - The item whose details are being displayed in the details panels
        //    (less important than explicit selection, but still relevant context)
        if (ctx.detailsItem) {
            const prefix = ctx.selectedItems && ctx.selectedItems.find((item: any) => item.id === ctx.detailsItem.id)
                ? 'Also viewing details for'
                : 'Viewing details for';
            parts.push(`${prefix}: ${ctx.detailsItem.type} "${ctx.detailsItem.title}" (${ctx.detailsItem.id})`);
        }
        
        return parts.length > 0 ? `\n\nUser's Current Context:\n${parts.join('\n')}` : '';
    };

    const systemInstruction = `
        You are a task execution system for a CMS, not a conversational assistant. Your role is to execute commands and confirm what was done - nothing more.

        CONVERSATION HISTORY: The history shows previous commands and results. Use it to understand references but do not recap or mention it in your task confirmation.

        FINISHING: When calling the 'finish' tool:
        1. 'taskConfirmation': This MUST contain ONLY the factual confirmation of the CURRENT request (e.g., "Created bundle 'X' (id)"). This is shown to the user.
        2. 'conversationalFiller': This is the ONLY place where you can add things like "I can help you...", "As discussed...", or other conversational elements. These will be hidden from the user.

        YOUR TASK CONFIRMATIONS: Must contain ONLY a confirmation of what was accomplished for the current request.
        CORRECT: "Created bundle 'Images' (tcm:5-467-8192) in folder 'Nick' (tcm:5-404-2)."
        WRONG: "I can help you... Created bundle..."

        **Understanding User Context:**
        - "Browsing in" indicates the folder/container the user is currently exploring. This is their PRIMARY location.
        - "Selected" indicates items the user has explicitly chosen (checked). These are the items they want to act upon.
        - "Viewing details for" indicates the item for which details are being displayed in the various 'details' panels. If there are no selected items, this might be what the user wants to work with, but the browsing location is still their primary context.
        - When a user asks "what folder am I in?" or similar questions, they're asking about the "Browsing in" location, NOT the focused item.

        **Formatting Item References:**
        - CRITICAL: Whenever you reference a CMS item in your response, ALWAYS use this format: "Title" (id)
        - Examples: 
          • "Products" (tcm:5-123-2)
          • "Hero Banner" (tcm:5-456-16)
          • "Homepage" (tcm:5-789-64)
          • "Product Image" (ecl:provider-123)
        - This format makes items clickable in the user interface, allowing users to navigate directly to the referenced item.
        - ALWAYS include both the title in quotes and the item ID (either TCM URI or ECL URI) in parentheses.
        - You may optionally include a descriptive word before the title (e.g., 'folder "Products"' or 'page "Homepage"') for clarity, but this is not required.

        **Answering Informational Questions:**
        - For informational questions (e.g., 'what tools are available?', 'what time is it?'), provide the answer directly using tools if needed.
        - Exception: If asked about your capabilities, you may provide a comprehensive answer. But for all subsequent task-based requests, revert to the task execution mode described above. 

        **Error Handling Rules:**
        - If the last tool execution resulted in an error, analyze the error message.
        - If the error is 'ItemAlreadyExists' or a '409 Conflict' because an item name is not unique, this can mean that an item with this name already exists in an inherited 'copy' of this container in a child or descendent publication.
        - Decide if you can fix the problem by calling the same tool with different arguments, by calling a different tool, or if the error is unrecoverable.
        - If you cannot recover from the error, call the 'finish' tool with a message explaining the failure.

        **Reasoning Steps:**
        1.  **Analyze Tool Output:** If the last message is a 'functionResponse', process that output. If it fully answers the user's question, call 'finish' with "finalMessage: '__NEEDS_SUMMARY__'". Otherwise, call the next logical tool.
        2.  **Analyze New Request:** For new requests, determine if I have all required parameters to call a tool.
        3.  **Ask for Missing Info:** If parameters are missing, call 'finish' asking for the needed details.
        4.  **Call a Tool:** If I have enough information, I will call the appropriate tool to make progress on the user's request. If I need multiple pieces of information about an item (e.g., its Content, and its Metadata), fetch ALL required properties in a single call using the 'includeProperties' parameter.
        5.  **Complete the Task:** Call 'finish' with only what was accomplished. Nothing else.

        User's Latest Request: "${prompt}"${formatContext(context)}
    `;

    let result: GenerateContentResponse;
    try {
        result = await getGenAI().models.generateContent({
            model: "gemini-3-flash-preview",
            contents: history,
            config: {
                systemInstruction: systemInstruction,
                tools: [{ functionDeclarations: toolsForNextStep }],
                toolConfig: {
                    functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO }
                },
                thinkingConfig: {
                    thinkingLevel: ThinkingLevel.MEDIUM,
                }
            }
        });
    } catch (error) {
        console.error("[Reasoner] Gemini API call failed:", error);
        throw new Error(`Failed to get response from Gemini: ${error instanceof Error ? error.message : String(error)}`);
    }

    const calls = result.functionCalls;
    const modelResponseContent = result.candidates?.[0]?.content ?? null;

    // Filter to ensure we only process valid calls that have a name.
    // This satisfies TypeScript safety and prevents runtime errors in the Orchestrator.
    const validCalls = (calls || []).filter(call => call.name);

    // Handle case where no function calls were generated (fallback to text or 'finish')
    if (validCalls.length === 0) {
        console.warn("[Reasoner] Model did not return a valid function call. Assuming task is complete.");
        const textResponse = (result.text ?? "").trim();
        const planStep: PlanStep = {
            step: -1,
            tool: 'finish',
            args: { taskConfirmation: textResponse || "Task completed." },
            description: "Finish with a direct text response from the model.",
            status: 'pending'
        };
        return { planSteps: [planStep], modelResponseContent };
    }

    // Map ALL valid function calls to plan steps (supporting parallel calling)
    const currentFunctionCount = history.filter(h => h.role === 'function').length;
    
    const nextSteps: PlanStep[] = validCalls.map((call, index) => ({
        step: currentFunctionCount + 1 + index,
        description: `Call tool: ${call.name}`,
        tool: call.name!,
        args: call.args,
        status: 'pending'
    }));

    return { planSteps: nextSteps, modelResponseContent };
};

export const summarizeToolOutput = async (toolOutput: any, userPrompt: string): Promise<string> => {
    if (toolOutput === null || toolOutput === undefined) return "";

    const summaryPrompt = `
      Your ONLY task is to answer the user's question directly and concisely using the provided tool output.
      Be direct and to the point.

      ---
      EXAMPLE:
      User's Question: "What is the ID of the new folder?"
      Tool's Output: "{"Id":"tcm:1-23-2","Title":"New Folder"}"
      
      YOUR RESPONSE:
      The ID of the new folder is tcm:1-23-2.
      ---

      ACTUAL TASK:
      User's Question: "${userPrompt}"
      Tool's Output: "${JSON.stringify(toolOutput)}"

      YOUR RESPONSE:
    `;

    try {
        const result = await getGenAI().models.generateContent({
            model: "gemini-3-flash-preview",
            contents: summaryPrompt
        });
        return (result.text ?? "").trim();
    } catch (error) {
        console.error("[Summarizer] Error generating summary:", error);
        return `Completed with result: ${toolOutput}`;
    }
};
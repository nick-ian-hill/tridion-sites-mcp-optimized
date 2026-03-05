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
    history: Content[],
    allTools: any[],
    useAdvancedModel: boolean = false
): Promise<NextStepResult> => {
    const finishTool: FunctionDeclaration = {
        name: "finish",
        description: "Call this when the current request is complete or to answer the user's question directly.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                taskConfirmation: {
                    type: Type.STRING,
                    description: "The exact message to display to the user. For tool actions, state ONLY what was accomplished this turn. For informational questions, provide the full answer here."
                },
                conversationalFiller: {
                    type: Type.STRING,
                    description: "Any extra info, internal reasoning, or conversational filler. This will NOT be shown to the user."
                }
            },
            required: ['taskConfirmation']
        }
    };

    const toolsForNextStep = [...formatToolsForGemini(allTools), finishTool];

    const systemInstruction = `
        You are an expert, helpful assistant for a Content Management System (CMS). Your role is dual-purpose:
        1. Execute tasks efficiently and accurately using the provided tools.
        2. Answer the user's informational questions about the CMS, their context, or your capabilities.

        CONVERSATION HISTORY: Always check the history. Do not repeat answers, capabilities, or explanations you have already provided in previous turns unless explicitly asked.

        FINISHING: When calling the 'finish' tool:
        1. 'taskConfirmation': This MUST contain the exact message to display to the user.
           - For task executions: State ONLY the factual confirmation of the CURRENT user's request. Do not summarize the entire session or previous turns.
           - For informational questions: Provide your clear, comprehensive answer here (e.g., explaining what a bundle is, or what you can do).
        2. 'conversationalFiller': This is for anything that doesn't belong in the task confirmation.

        **Zero-Sum Reporting for Tasks:**
        Do not report actions you reported in previous turns.
        CORRECT: "Created folder 'Demo' (tcm:5-123-2)."
        WRONG: "Created bundle 'Images' and created folder 'Demo' (tcm:5-123-2)."

        **Understanding User Context:**
        - "Browsing in" indicates the folder/container the user is currently exploring. This is their PRIMARY location.
        - "Selected" indicates items the user has explicitly chosen (checked). These are the items they want to act upon.
        - "Viewing details for" indicates the item for which details are being displayed in the various 'details' panels.
        - When a user asks "what folder am I in?" or similar questions, they're asking about the "Browsing in" location.

        **Formatting Item References:**
        - CRITICAL: Whenever you reference a CMS item in your response, ALWAYS use this format: "Title" (id)
        - Examples: 
          • "Products" (tcm:5-123-2)
          • "Hero Banner" (tcm:5-456-16)
          • "Product Image" (ecl:provider-123)
        - NEVER guess or fabricate an item's title. If you know an item's ID but do not know its exact title, you MUST use the getItem tool to fetch the title.
        - ALWAYS include both the title in quotes and the item ID (either TCM URI or ECL URI) in parentheses.

        **Error Handling Rules:**
        - If the last tool execution resulted in an error, analyze the error message.
        - If the error is 'ItemAlreadyExists' or a '409 Conflict' because an item name is not unique, check if you can fix the problem by calling a different tool or adjusting arguments.
        - If you cannot recover from the error, call the 'finish' tool with a clear message explaining the failure in 'taskConfirmation'.

        **Bulk Operations & Orchestration (CRITICAL):**
        - If you need to process, inspect, fetch details, or mutate more than 3 items from a list, search result, or container, you MUST NOT call individual tools sequentially or in parallel (e.g., do not call 'getItem' 10 times).
        - Instead, you MUST use the 'toolOrchestrator' to process the entire batch of items in a single turn. Use the orchestrator to write the appropriate scripts (preProcessing, map, postProcessing) to handle discovery and logic entirely on the server side. You MUST ALWAYS include a 'validationScript' to audit the final state and verify that your actions actually succeeded.

        **Token Efficiency & Data Filtering:**
        - When fetching full items using 'getItem' or 'bulkReadItems', ALWAYS use the 'includeProperties' parameter to request ONLY the specific fields you actually need (e.g., ["Id", "Title", "type", "VersionInfo.RevisionDate"]).
        - Never fetch the full, unfiltered item object unless the user explicitly asks to see "all properties" or "all details".

        **Handling Ambiguous or Playful Prompts:**
        - If the user's request is completely nonsensical, highly ambiguous, or playfully out-of-domain (e.g., "Mango the orange..."), do NOT attempt to call CMS tools.
        - Instead, immediately call the 'finish' tool.
        - In the 'taskConfirmation', you may provide a brief, matching humorous or polite response, but you MUST immediately pivot and ask the user to clarify what they want to achieve in the CMS.

        **Reasoning Steps:**
        1. Analyze the new request and the conversation history.
        2. If the request is purely informational and you know the answer, call 'finish' immediately.
        3. If you lack required parameters for a tool, call 'finish' to ask the user for them.
        4. Call the necessary tools to progress the request. Fetch multiple properties at once if needed.
        5. Call 'finish' to deliver the final confirmation or answer.
    `;

    const modelToUse = useAdvancedModel ? "gemini-3.1-pro-preview" : "gemini-3-flash-preview";
    if (useAdvancedModel) {
        console.log(`[Reasoner] Escalating to advanced model: ${modelToUse}`);
    }

    let result: GenerateContentResponse | undefined;
    let retries = 3;
    let delayMs = 4000;

    while (retries > 0) {
        try {
            result = await getGenAI().models.generateContent({
                model: modelToUse,
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
            break;
        } catch (error: any) {
            const errorString = typeof error === 'object' ? JSON.stringify(error) + String(error) : String(error);

            const isRetryable =
                errorString.includes('429') ||          // Rate limits
                errorString.includes('500') ||          // Internal Server Error
                errorString.includes('503') ||          // Service Unavailable
                errorString.includes('fetch failed') || // Node.js network blip
                errorString.includes('ETIMEDOUT') ||    // Connection timeout
                errorString.includes('ECONNRESET');     // Connection reset by peer

            if (isRetryable && retries > 1) {
                console.warn(`[Reasoner] Transient API/Network issue detected. Retrying in ${delayMs / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                delayMs *= 1.5;
                retries--;
            } else {
                console.error("[Reasoner] Gemini API call failed:", error);
                throw new Error(`Failed to get response from Gemini: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    if (!result) {
        throw new Error("Failed to generate content after retries.");
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
      Do NOT recap previous actions, mention previous turns, or summarize the overall state of the session.

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

/**
 * Uses the advanced Pro model to evaluate the agent's history and determine 
 * if it is making forward progress, generating a direct user message if a pause is needed.
 */
export const assessTaskProgress = async (
    history: Content[],
    originalPrompt: string
): Promise<{ isMakingProgress: boolean, userMessage: string }> => {
    const prompt = `
    You are the autonomous CMS Agent evaluating your own progress.
    The user's original goal was: "${originalPrompt}"
    
    Review your conversation history with the system tools.
    Determine if you are making logical, forward progress toward the goal, or if you are stuck in a loop, taking too long, or lost.
    
    Return a JSON object with EXACTLY this structure:
    {
        "isMakingProgress": boolean, // true if you are actively making good progress and nearing completion. false if you are stuck, looping, or taking an unusually long time.
        "userMessage": string // Write the EXACT, complete message to show the user if you need to pause. Polite, conversational, and professional. State that the task is taking a while, summarize what you've accomplished so far, and ask the user how they would like to proceed.
    }
    `;

    try {
        const response = await getGenAI().models.generateContent({
            model: "gemini-3.1-pro-preview",
            contents: [...history, { role: 'user', parts: [{ text: prompt }] }],
            config: {
                responseMimeType: "application/json",
                thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM }
            }
        });

        const text = response.text || "{}";
        return JSON.parse(text);
    } catch (error) {
        console.error("[Overseer] Failed to assess progress:", error);
        return {
            isMakingProgress: false,
            userMessage: "I am taking longer than expected to complete this task, but I wanted to check in before proceeding further. Would you like me to continue or change my approach?"
        };
    }
};

/**
 * Uses the advanced Pro model to evaluate a sequence of errors and write a complete, user-friendly message explaining why the agent is stuck.
 */
export const summarizeFailureState = async (
    history: Content[],
    originalPrompt: string
): Promise<string> => {
    const prompt = `
    You are the autonomous CMS Agent speaking directly to the user.
    The user's original goal was: "${originalPrompt}"
    
    Review the conversation history, paying special attention to the recent errors returned by the system tools.
    You have hit multiple consecutive errors and are currently stuck.
    
    Your task is to write the EXACT final message that will be shown to the user. 
    In your message:
    1. Briefly and politely explain what you were trying to do.
    2. Explain the specific nature of the errors preventing you from continuing (e.g., "I tried to create the folder, but a folder with that name already exists").
    3. Ask the user for clarification, guidance, or permission to try a different approach.
    
    Keep the tone helpful, professional, and conversational. Do not wrap your response in JSON; just provide the raw text message.
    `;

    try {
        const response = await getGenAI().models.generateContent({
            model: "gemini-3.1-pro-preview",
            contents: [...history, { role: 'user', parts: [{ text: prompt }] }],
            config: {
                thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM }
            }
        });

        return (response.text || "").trim();
    } catch (error) {
        console.error("[Overseer] Failed to summarize failure state:", error);
        return "I encountered several repeated errors while trying to complete this task, and I'm currently stuck. Could you clarify the requirement or provide some guidance on how to proceed?";
    }
};
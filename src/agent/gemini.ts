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
    delete schema.minimum;
    delete schema.maximum;
    delete schema.exclusiveMinimum;
    delete schema.exclusiveMaximum;

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

        **1. Finishing Tasks & Responding to the User**
        When calling the 'finish' tool:
        - 'taskConfirmation': This MUST contain the exact message to display to the user.
           - For task executions: State ONLY the factual confirmation of the CURRENT user's request. Do not summarize the entire session or previous turns.
           - For informational questions: Provide your clear, comprehensive answer here.
        - 'conversationalFiller': Use this for internal reasoning or extra info. It will NOT be shown to the user.
        - Zero-Sum Reporting: Do not report actions you already reported in previous turns.
           - CORRECT: "Created folder 'Demo' (tcm:5-123-2)."
           - WRONG: "Created bundle 'Images' and created folder 'Demo' (tcm:5-123-2)."

        **2. Understanding User Context**
        - "Browsing in": The primary location/folder the user is exploring. (e.g., if asked "what folder am I in?", reference this).
        - "Selected": Items the user has explicitly chosen (checked) to act upon.
        - "Viewing details for": The item currently displayed in the details panels.

        **3. Formatting Item References**
        - ALWAYS use this format when referencing a CMS item: "Title" (id)
           - Examples: "Products" (tcm:5-123-2) or "Product Image" (ecl:provider-123)
        - When naming the item type, place the type word BEFORE the quoted title, not after: write folder "Images" (tcm:5-1748-2), NOT "Images" folder (tcm:5-1748-2). Alternatively, use "Images" (tcm:5-1748-2) folder.
        - NEVER apply bold, italic, or any other markdown formatting to item references. The correct format is always plain text with quotes: "Title" (id). NEVER write: **"Title"** (id), **Title** (id), or *Title* (id).
        - NEVER guess or fabricate an item's title. If you only know the ID, you MUST use the 'getItem' tool to fetch the title.

        **4. BluePrint Architecture Best Practices**
        Unless the user explicitly dictates the exact publication, autonomously follow Tridion BluePrint hierarchy conventions:
        - Schema Master: Create Schemas and Categories here.
        - Design Master: Create Component Templates and Page Templates here.
        - Content Master: Create reusable master content (Components) here.
        - Website Master: Create reusable Pages and Structure Groups here.
        - Children of Website Master: Localize content, pages, and structure groups etc. (if required) in child publications of Website Master.
        - Use 'getRelatedBluePrintItems' (navigating 'Ancestor' or 'Parent' relationships) to find the appropriate master publication before creating global items.

        **5. Error Handling**
        - If a tool fails, analyze the error. For 'ItemAlreadyExists' (409 Conflict), see if you can adjust arguments or use a different tool to recover.
        - If unrecoverable, call 'finish' and explain the failure clearly in 'taskConfirmation'.

        **6. Bulk Operations & Orchestration**
        - If you need to process, inspect, or mutate more than 3 items, use the 'toolOrchestrator' to process the batch server-side.
        - **SINGLE-CALL FOR HEAVY DATA:** When importing from Excel, do it in a single orchestrator call. Use 'preProcessingScript' to parse the file and pass data via memory ('preProcessingResult') to the 'mapScript'. Do not dump data into the chat.
        - **MANDATORY DRY RUN:** Before executing a large batch, you MUST test your script first. Call 'toolOrchestrator' passing ONLY 1 or 2 items in the 'itemIds' array. Evaluate the result. Only proceed with the remaining items if the dry run succeeds.
        - **FAIL LOUDLY & FAST:** Do NOT wrap your primary mutation API calls (e.g., 'createPage', 'createComponent') in 'try/catch' blocks that return null. Let errors throw naturally. Leave 'stopOnError' as true (the default) so the orchestrator halts immediately on the first error and reports the exact issue to you. DO NOT set stopOnError to false.
        - **DEFENSIVE VALIDATION:** Your 'validationScript' MUST be defensive. Do not blindly access properties (e.g., 'context.successes[0].result.itemId') without checking if 'result' and 'itemId' are valid, as items may have returned incomplete data.
        - Reporting Bulk Operations: Review the orchestrator's output carefully. If any items failed or generated warnings, you MUST explicitly report the exact number and the reasons in your 'taskConfirmation'.

        **7. Handling Large Datasets & Excel Files (Data-Driven Modeling)**
        - NEVER read an entire large Excel data sheet directly into the chat context.
        - Step 1 (Triage): Call 'readUploadedFile' or 'readMultimediaComponent' with 'maxRows': 3.
        - Step 2 (Metadata Analysis): Inspect the rows returned for EACH sheet. Look for sheets named "Notes" or "Instructions". If they contain critical logic and appear truncated (compare 'Data.length' to 'TotalRows'), IMMEDIATELY call the read tool again using the 'targetSheet' parameter for ONLY that specific sheet WITHOUT 'maxRows'.
        - Step 3 (Schema Verification): Do NOT guess standard fields or layouts (e.g., assuming a single "Main" region on a page). Your Schemas and Templates MUST perfectly match the dataset. If the 3 triage rows are not enough to confirm all required variables, write a 'toolOrchestrator' script (omitting 'mapScript') to read the full file server-side and return a summary of all unique data variations (e.g., an array of all unique regions referenced).
        - Step 4 (Dry Run Execution): Write your final 'toolOrchestrator' script, but restrict it to process ONLY 1 or 2 rows/items first. This is critical to prevent slow, massive failures if your script logic or mapping has a bug. 
        - Step 5 (Full Execution): Only after the Dry Run succeeds and your 'validationScript' passes should you use the 'toolOrchestrator' to process the remaining dataset.

        **8. Destructive Actions (Requires Consent)**
        - You MUST NEVER delete an item using 'deleteItem', 'undoCheckOutItem' (for items without a major version), or the 'toolOrchestrator' without EXPLICIT, prior confirmation from the user (unless you just created it this turn).
        - To request permission, call 'finish'. List items by Title and ID (up to 10). If more than 10, state the total count, provide 3 examples, and state the folder context.
        - Only proceed with deletion if the user's next message is a clear affirmative.

        **9. Token Efficiency & Data Filtering**
        - When using 'getItem' or 'bulkReadItems', ALWAYS use the 'includeProperties' parameter to request ONLY the specific fields you need (e.g., ["Id", "Title", "type"]).
        - Never fetch the full item object unless explicitly asked to see "all properties".

        **10. Missing Files, Ambiguous, & Nonsensical Prompts (SHORT-CIRCUIT RULES)**
        - Missing Files: If the user refers to an "attached file" but no "Attached Files" list is present in your context, you MUST STOP IMMEDIATELY. Do NOT attempt to search for folders, publications, or gather other context. Call 'finish' immediately to ask the user to attach the file.
        - Ambiguous Prompts: If a CMS request is too vague to execute safely (e.g., "update the article" with no context of *which* article or *what* to update), do NOT start guessing or executing broad searches. Call 'finish' immediately to ask the user for specific names, IDs, or the exact changes required.
        - Playful/Nonsensical Prompts: If a request is completely out-of-domain (e.g., "Mango the orange..."), do NOT call CMS tools. Call 'finish' immediately with a brief polite or humorous response, then pivot to asking how you can help with the CMS.

        **Reasoning Steps:**
        1. Analyze the new request and the conversation history.
        2. If informational, call 'finish' immediately.
        3. If lacking required parameters, call 'finish' to ask the user.
        4. Call necessary tools to progress (fetch multiple properties at once if needed).
        5. Call 'finish' to deliver the final confirmation.
    `;

    const modelToUse = useAdvancedModel ? "gemini-3.1-pro-preview" : "gemini-3-flash-preview";
    if (useAdvancedModel) {
        console.log(`[Reasoner] Escalating to advanced model: ${modelToUse}`);
    }

    let result: GenerateContentResponse | undefined;
    let retries = 3;
    let delayMs = 2000;

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
            const statusCode = error?.status || error?.response?.status || "Unknown";

            const isRateLimit = errorString.includes('429') || errorString.includes('RESOURCE_EXHAUSTED');
            const isRetryable =
                isRateLimit ||
                errorString.includes('500') ||          // Internal Server Error
                errorString.includes('503') ||          // Service Unavailable
                errorString.includes('fetch failed') || // Node.js network blip
                errorString.includes('ETIMEDOUT') ||    // Connection timeout
                errorString.includes('ECONNRESET');     // Connection reset by peer

            if (isRetryable && retries > 1) {
                let waitTimeMs = delayMs;

                // If it's a rate limit, try to extract the required wait time from the error message
                if (isRateLimit) {
                    const match = errorString.match(/retry in ([\d.]+)s/i) || errorString.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
                    if (match && match[1]) {
                        // Extract the seconds, convert to MS, and add a 1-second safety buffer
                        waitTimeMs = Math.ceil(parseFloat(match[1]) * 1000) + 1000;
                    } else {
                        waitTimeMs = 10000;
                    }
                } else {
                    waitTimeMs = delayMs;
                }

                console.warn(`[Reasoner] API/Network issue detected (Status: ${statusCode}). Retrying in ${waitTimeMs / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, waitTimeMs));

                if (!isRateLimit) {
                    delayMs *= 1.5; // Apply exponential backoff only to non-quota network blips
                }
                retries--;
            } else {
                console.error("[Reasoner] Gemini API call failed:", error);
                throw new Error(`Failed to get response from Gemini (Status: ${statusCode}): ${error instanceof Error ? error.message : String(error)}`);
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

    // Map ALL valid function calls to plan steps (supporting parallel calling)
    const currentFunctionCount = history.filter(h => h.role === 'function').length;

    // Handle case where no function calls were generated (API dropped malformed JSON)
    if (validCalls.length === 0) {
        console.warn("[Reasoner] Model did not return a valid function call. Injecting recovery step to continue loop.");
        
        const errorMessage = "SYSTEM ALERT: Your previous response was invalid or empty. This usually happens when you try to generate a massive mapScript and make a JSON escaping syntax error. Do not write massive scripts. Simplify your logic or break the task into smaller steps.";

        // 1. Synthesize the model's dropped call so the history structure remains valid
        const safeContent: Content = { 
            role: 'model', 
            parts: [{ 
                functionCall: {
                    name: "toolOrchestrator",
                    args: { preProcessingScript: `throw new Error("${errorMessage}");` }
                }
            }] 
        };

        // 2. Queue the synthesized step. The orchestrator will run this, fail immediately, 
        // append the helpful error to the history, and trigger the next turn automatically!
        const planStep: PlanStep = {
            step: currentFunctionCount + 1,
            tool: 'toolOrchestrator',
            args: { preProcessingScript: `throw new Error("${errorMessage}");` },
            description: "System injected error recovery.",
            status: 'pending'
        };

        return { planSteps: [planStep], modelResponseContent: safeContent };
    }

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
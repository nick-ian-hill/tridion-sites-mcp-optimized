import { GoogleGenAI, FunctionDeclaration, Content, Type, GenerateContentResponse, FunctionCallingConfigMode  } from "@google/genai";
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PlanStep } from './types.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    throw new Error("Server is not configured with a GEMINI_API_KEY.");
}

const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// The desired execution strategy
export interface DetectedIntent {
    strategy: 'FORCE_TOOL_CALL' | 'AUTO_MODE';
}

/**
 * Detects the user's intent and determines the best execution strategy.
 */
export const detectIntent = async (prompt: string): Promise<DetectedIntent> => {
    const tools: FunctionDeclaration[] = [
        {
            name: 'forceToolExecutionForAction',
            description: 'Use for any specific user command that implies performing a clear action or task, such as "create", "update", "delete", "get item", "move", "copy", "search for".',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'answerInformationally',
            description: 'Use for conversational questions, requests for information about the agent\'s capabilities (e.g., "what can you do?", "list tools"), or ambiguous requests where a direct text answer might be better than forcing a tool.',
            parameters: { type: Type.OBJECT, properties: {} }
        }
    ];

    const systemInstruction = `You are an expert intent strategist. Analyze the user's prompt and decide on the best execution mode. If it's a clear command, choose 'forceToolExecutionForAction'. If it's a question about capabilities or seems conversational, choose 'answerInformationally'. You MUST call one of the provided functions.`;

    try {
        const result = await genAI.models.generateContent({
            model: "gemini-2.5-pro",
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                systemInstruction,
                tools: [{ functionDeclarations: tools }],
                toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
                temperature: 0.0
            }
        });

        const call = result.functionCalls?.[0];
        if (call?.name === 'answerInformationally') {
            console.log("[IntentDetector] Strategy: AUTO_MODE (Informational/Conversational)");
            return { strategy: 'AUTO_MODE' };
        }
        
        console.log("[IntentDetector] Strategy: FORCE_TOOL_CALL (Action/Command)");
        return { strategy: 'FORCE_TOOL_CALL' }; // Default to the more common case

    } catch (error) {
        console.error("[IntentDetector] Error detecting intent, defaulting to FORCE_TOOL_CALL:", error);
        return { strategy: 'FORCE_TOOL_CALL' }; // Failsafe
    }
};

// Helper to clean Zod schemas for Gemini
const removeUnsupportedProperties = (schema: any): any => {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(removeUnsupportedProperties);

    delete schema.$schema;
    delete schema.additionalProperties;
    // Allow 'null' type alongside others by picking the primary type
    if (schema.type && Array.isArray(schema.type)) {
        schema.type = schema.type.find((t: string) => t !== 'null') || schema.type[0];
    }
    for (const key in schema) {
        schema[key] = removeUnsupportedProperties(schema[key]);
    }
    return schema;
};

// Converts our internal tool definitions to Gemini's expected format
const formatToolsForGemini = (tools: any[]): FunctionDeclaration[] => {
    return tools.map(tool => {
        const zodSchema = z.object(tool.input);
        let jsonSchema = zodToJsonSchema(zodSchema);
        jsonSchema = removeUnsupportedProperties(jsonSchema);
        return {
            name: tool.name,
            description: tool.description,
            parameters: jsonSchema as any
        };
    });
};

/**
 * Determines the single next step for the agent to take.
 */
export const determineNextStep = async (
    prompt: string,
    contextItemId: string | undefined,
    history: Content[],
    relevantTools: any[],
    functionCallingMode: FunctionCallingConfigMode = FunctionCallingConfigMode.ANY // Default to ANY
): Promise<PlanStep | null> => {
    const finishTool: FunctionDeclaration = {
        name: "finish",
        description: "Call this tool to signal that you have fully completed the user's request and all tasks are done.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                finalMessage: {
                    type: Type.STRING,
                    description: "A concluding message for the user summarizing the outcome."
                }
            },
            required: ['finalMessage']
        }
    };

    const toolsForNextStep = [...formatToolsForGemini(relevantTools), finishTool];

    const systemInstruction = `
        You are an expert orchestrator for a CMS. Your goal is to fulfill the user's request by calling tools one at a time.
        
        **Current Mode: ${functionCallingMode}**
        - If Mode is ANY, you MUST respond by calling a single tool. Do not respond with text.
        - If Mode is AUTO, you have the flexibility to either call a tool OR respond directly with a text message if that is more appropriate (e.g., for a simple conversational question).

        **Answering Informational Questions:**
        - If the user's request is a direct question for information (e.g., 'list the tools', 'what is the current time?') and doesn't seem to be part of a larger multi-step task, your primary goal is conciseness.
        - If a single tool can provide the answer, call that tool. In the *next* step, your ONLY action should be to call the 'finish' tool with a 'finalMessage' that directly and concisely answers the user's question. 

        **Error Handling Rules:**
        - If the last tool execution resulted in an error, analyze the error message.
        - If an action fails due to a BluePrint error (e.g., "Cannot paste across Publications"), your first recovery step should be to use the 'mapItemIdToContextPublication' tool. Provide it with the source item's ID and an ID from the target context (like the destination folder ID). Then, use 'getItem' with the 'mapped' ID from the result to check if the item exists before proceeding.
        - If the error is 'ItemAlreadyExists' or a '409 Conflict' because an item name is not unique, this can mean that an item with this name already exists in an inherited 'copy' of this container in a child or descendent publication.
        - Decide if you can fix the problem by calling the same tool with different arguments, by calling a different tool, or if the error is unrecoverable.
        - If you cannot recover from the error, call the 'finish' tool with a message explaining the failure.

        **Reasoning Steps:**
        1.  **Analyze Tool Output:** Check the last message in the conversation history. If it is a 'functionResponse', your entire focus is to process that output.
            - If the output directly and completely answers the user's latest question, your ONLY next step is to call the 'finish' tool with the special argument "finalMessage: '__NEEDS_SUMMARY__'".
            - If the output is an intermediate step towards a larger goal, call the next logical tool.
        2.  **Analyze New Request:** If there is no recent tool output, analyze the user's latest request. Do I have all the required parameters (e.g., 'title', 'locationId') to use a tool based on the user's request?
        3.  **Ask for Missing Info:** If required information is missing, I MUST call the 'finish' tool. I will use its 'finalMessage' parameter to ask the user for the necessary details.
        4.  **Call a Tool:** If I have enough information, I will call the appropriate tool to make progress on the user's request.
        5.  **Complete the Task:** When the user's request has been fully addressed, call the 'finish' tool with a message summarizing what was done.

        User Request: "${prompt}"
        ${contextItemId ? `Context Item ID: "${contextItemId}"` : ''}
    `;

    const result: GenerateContentResponse = await genAI.models.generateContent({
        model: "gemini-2.5-pro",
        contents: history,
        config: {
            systemInstruction: systemInstruction,
            tools: [{ functionDeclarations: toolsForNextStep }],
            toolConfig: {
                functionCallingConfig: { mode: functionCallingMode } // Dynamically set the mode
            },
            temperature: 0.0
        }
    });
    
    const call = result.functionCalls?.[0];

    if (!call || !call.name) {
        console.warn("[Reasoner] Model did not return a function call. Assuming task is complete.");
        const textResponse = (result.text ?? "").trim();
        return {
            step: -1,
            tool: 'finish',
            args: { finalMessage: textResponse || "Task completed." },
            description: "Finish with a direct text response from the model.",
            status: 'pending'
        }
    }

    const nextStep: PlanStep = {
        step: history.filter(h => h.role === 'function').length + 1,
        description: `Call tool: ${call.name}`,
        tool: call.name,
        args: call.args,
        status: 'pending'
    };

    return nextStep;
};

export const selectRelevantTools = async (prompt: string, allTools: any[], maxTools: number = 6): Promise<any[]> => {
    const toolLister: FunctionDeclaration = {
        name: 'setSelectedTools',
        description: 'Use this function to provide the list of tools relevant to the user\'s request.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                toolNames: {
                    type: Type.ARRAY,
                    description: 'An array of the names of the tools that are most relevant to the user\'s request.',
                    items: { type: Type.STRING }
                }
            },
            required: ['toolNames']
        }
    };

    const simplifiedTools = allTools.map(t => ({ name: t.name, description: t.description }));

    const systemInstruction = `
        You are a tool routing expert. Your job is to analyze the user's request and the list of available tools.
        You must select the top ${maxTools} most relevant tools that are likely to be needed to fulfill the user's request.
        Consider that the user might issue follow-up commands. For example, if they ask to "create a folder", they might later ask to "get the item" or "move it", so include related tools.
        If the user asks a question about an item (e.g., "what is its ID?"), you must include tools for retrieving items like 'getItem'.
        You MUST call the 'setSelectedTools' function with the names of your selected tools.
    `;

    const fullPrompt = `
        User Request: "${prompt}"

        Available Tools:
        ${JSON.stringify(simplifiedTools, null, 2)}
    `;

    try {
        const result = await genAI.models.generateContent({
            model: "gemini-2.5-pro",
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: {
                systemInstruction,
                tools: [{ functionDeclarations: [toolLister] }],
                toolConfig: {
                    functionCallingConfig: {
                        mode: FunctionCallingConfigMode.ANY,
                    }
                },
                temperature: 0.0
            }
        });

        const call = result.functionCalls?.[0];
        if (call?.name === 'setSelectedTools' && call.args?.toolNames) {
            const toolNames = call.args.toolNames as string[];
            console.log(`[ToolRouter] Selected ${toolNames.length} relevant tools:`, toolNames);
            const relevantTools = allTools.filter(t => toolNames.includes(t.name));
            if (!relevantTools.some(t => t.name === 'finish')) {
                 const finishTool = allTools.find(t => t.name === 'finish');
                 if(finishTool) relevantTools.push(finishTool);
            }
            return relevantTools;
        }

        console.warn("[ToolRouter] Model did not select tools as expected. Falling back to all tools.");
        return allTools;
    } catch (error) {
        console.error("[ToolRouter] Error selecting relevant tools, falling back to all tools:", error);
        return allTools;
    }
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
        const result = await genAI.models.generateContent({
            model: "gemini-2.5-flash",
            contents: summaryPrompt,
            config: {
                temperature: 0.0
            }
        });
        return (result.text ?? "").trim();
    } catch (error) {
        console.error("[Summarizer] Error generating summary:", error);
        return `Completed with result: ${toolOutput}`;
    }
};
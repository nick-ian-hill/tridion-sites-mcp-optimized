import { GoogleGenAI, FunctionDeclaration, Content, Type, GenerateContentResponse, FunctionCallingConfigMode  } from "@google/genai";
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PlanStep } from './types.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    throw new Error("Server is not configured with a GEMINI_API_KEY.");
}

const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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
 * Determines the single next step for the agent to take. (ReAct model)
 */
export const determineNextStep = async (
    prompt: string,
    contextItemId: string | undefined,
    history: Content[],
    relevantTools: any[]
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
        You MUST respond by calling a single tool. Do not respond with text.
        When formulating a response, especially for the 'finalMessage' in the 'finish' tool, you MUST use Markdown for any formatting (like lists, bold text, or code snippets).
        Review the conversation history and the user's latest request, then decide on the single next action to take.

        **Error Handling Rules:**
        - If the last tool execution resulted in an error, analyze the error message.
        - If an action fails due to a BluePrint error (e.g., "Cannot paste across Publications"), your first recovery step should be to use the 'mapItemIdToContextPublication' tool. Provide it with the source item's ID and an ID from the target context (like the destination folder ID). Then, use 'getItem' with the 'mapped' ID from the result to check if the item exists before proceeding.
        - If the error is 'ItemAlreadyExists' or a '409 Conflict' because an item name is not unique, this can mean that an item with this name already exists in an inherited 'copy' of this container in a child or descendent publication.
        - Decide if you can fix the problem by calling the same tool with different arguments, by calling a different tool, or if the error is unrecoverable.
        - If you cannot recover from the error, call the 'finish' tool with a message explaining the failure.

        **Reasoning Steps:**
        0.  **PRIORITY 1: Analyze Tool Output.** Check the last message in the conversation history. If it is a 'functionResponse', your entire focus is to process that output.
            - If the tool's output directly and completely answers the user's latest question, your ONLY next step is to call the 'finish' tool with the special argument "finalMessage: '__NEEDS_SUMMARY__'".
            - If the output is an intermediate step towards a larger goal, call the next logical tool.
            - **Crucially, do not re-answer previous questions or get distracted by the conversational history prior to the tool call. Focus exclusively on the tool's output and the user's latest request.**
        1.  **Handle General Questions:** If the user's LATEST request is a general question that does not map to a specific tool or command (e.g., "what can you do?", "who are you?", "can you help me?"), you MUST call the 'finish' tool with a helpful, conversational response in the 'finalMessage'.
        2.  **Analyze New Request:** If there is no recent tool output, analyze the user's latest request. Do I have all the required parameters (e.g., 'title', 'locationId') to use a tool based on the user's request?
        3.  **Ask for Missing Info:** If required information is missing, I MUST call the 'finish' tool. I will use its 'finalMessage' parameter to ask the user for the necessary details. Example: 'finish(finalMessage="I can create that bundle, but what would you like to name it?").
        4.  **Call a Tool:** If I have enough information, I will call the appropriate tool to make progress on the user's request.
        5.  **Complete the Task:** When the user's request has been fully addressed (e.g., after creating an item where no summary is needed), I will call the 'finish' tool with a message summarizing what was done.

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
                functionCallingConfig: {
                    // Force the model to call a function. It cannot return text.
                    mode: FunctionCallingConfigMode.ANY,
                }
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

/**
 * Summarization Module
 */
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
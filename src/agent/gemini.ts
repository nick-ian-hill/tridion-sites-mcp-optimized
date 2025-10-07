import { GoogleGenerativeAI, FunctionDeclarationSchema } from "@google/generative-ai";
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PlanStep, Content } from './types.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    throw new Error("Server is not configured with a GEMINI_API_KEY.");
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

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
const formatToolsForGemini = (tools: any[]): any[] => {
    return tools.map(tool => {
        const zodSchema = z.object(tool.input);
        let jsonSchema = zodToJsonSchema(zodSchema);
        jsonSchema = removeUnsupportedProperties(jsonSchema);
        return {
            name: tool.name,
            description: tool.description,
            parameters: jsonSchema as FunctionDeclarationSchema
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
    // We add a virtual 'finish' tool for the model to call when the task is complete.
    const finishTool = {
        name: "finish",
        description: "Call this tool to signal that you have fully completed the user's request and all tasks are done.",
        parameters: {
            type: 'object',
            properties: {
                finalMessage: {
                    type: 'string',
                    description: "A concluding message for the user summarizing the outcome."
                }
            },
            required: ['finalMessage']
        }
    };

    const toolsForNextStep = [...formatToolsForGemini(relevantTools), finishTool];

    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-pro",
        tools: [{ functionDeclarations: toolsForNextStep }],
        generationConfig: { temperature: 0.0 }
    });

    const fullPrompt = `
        You are an expert orchestrator for a CMS. Your goal is to fulfill the user's request by calling tools one at a time.
        Review the conversation history and the user's latest request, then decide on the single next action to take.

        **Error Handling Rules:**
        - If the last tool execution resulted in an error, analyze the error message.
        - If the error is 'ItemAlreadyExists' or a '409 Conflict' because an item name is not unique, this can mean that an item with this name already exists in an inherited 'copy' of this container in a child or descendent publication.
        - Decide if you can fix the problem by calling the same tool with different arguments, by calling a different tool, or if the error is unrecoverable.
        - If you cannot recover from the error, call the 'finish' tool with a message explaining the failure.

        **General Rules:**
        - If you have enough information to complete the request, call the 'finish' tool.
        - Otherwise, call the tool that will get you closer to fulfilling the request.

        User Request: "${prompt}"
        ${contextItemId ? `Context Item ID: "${contextItemId}"` : ''}
    `;

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(fullPrompt);
    const call = result.response.functionCalls()?.[0];

    if (!call) {
        console.warn("[Reasoner] Model did not return a function call. Assuming task is complete.");
        return {
            step: -1, // This step won't be executed, it's just a signal
            tool: 'finish',
            args: { finalMessage: result.response.text() || "Task completed." },
            description: "Finish the task.",
            status: 'pending'
        };
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
export const summarizeToolOutput = async (toolOutput: any, originalPrompt: string): Promise<string> => {
    // If there's nothing to summarize, return an empty string.
    if (toolOutput === null || toolOutput === undefined) return "";

    const summarizerModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: { temperature: 0.2 }
    });

    const summaryPrompt = `
        Directly and concisely answer the user's question in a natural, conversational way using the provided tool output.
        
        User's Question: "${originalPrompt}"
        Tool's Output: "${JSON.stringify(toolOutput)}"
    `;

    try {
        const result = await summarizerModel.generateContent(summaryPrompt);
        return result.response.text().trim();
    } catch (error) {
        console.error("[Summarizer] Error generating summary:", error);
        return `Completed with result: ${toolOutput}`;
    }
};
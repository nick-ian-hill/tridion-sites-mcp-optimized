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
    planStep: PlanStep | null;
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
 * Determines the single next step for the agent to take.
 */
export const determineNextStep = async (
    prompt: string,
    contextItemId: string | undefined,
    history: Content[],
    allTools: any[]
): Promise<NextStepResult> => {
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

    const toolsForNextStep = [...formatToolsForGemini(allTools), finishTool];

    const systemInstruction = `
        You are an expert orchestrator for a CMS. Your goal is to fulfill the user's request. You have the flexibility to either call a tool OR respond directly with a text message if that is more appropriate (e.g., for a simple conversational question).

        **Answering Informational Questions:**
        - If the user's request is a direct question for information (e.g., 'list the tools', 'what is the current time?') and doesn't seem to be part of a larger multi-step task, your primary goal is conciseness.
        - If a single tool can provide the answer, call that tool. In the *next* step, your ONLY action should be to call the 'finish' tool with a 'finalMessage' that directly and concisely answers the user's question. 

        **Error Handling Rules:**
        - If the last tool execution resulted in an error, analyze the error message.
        - If the error is 'ItemAlreadyExists' or a '409 Conflict' because an item name is not unique, this can mean that an item with this name already exists in an inherited 'copy' of this container in a child or descendent publication.
        - Decide if you can fix the problem by calling the same tool with different arguments, by calling a different tool, or if the error is unrecoverable.
        - If you cannot recover from the error, call the 'finish' tool with a message explaining the failure.

        **Reasoning Steps:**
        1.  **Analyze Tool Output:** Check the last message in the conversation history. If it is a 'functionResponse', your entire focus is to process that output.
            - If the output directly and completely answers the user's latest question, your ONLY next step is to call the 'finish' tool with the special argument "finalMessage: '__NEEDS_SUMMARY__'".
            - If the output is an intermediate step towards a larger goal, call the next logical tool.
        2.  **Analyze New Request:** If there is no recent tool output, analyze the user's latest request. Do I have all the required parameters (e.g., 'title', 'locationId') to use a tool based on the user's request?
        3.  **Ask for Missing Info:** If required information is missing, I MUST call the 'finish' tool. I will use its 'finalMessage' parameter to ask the user for the necessary details.
        4.  **Call a Tool:** If I have enough information, I will call the appropriate tool to make progress on the user's request. If I need multiple pieces of information about an item (e.g., its Content, and its Metadata), fetch ALL required properties in a single call using the 'includeProperties' parameter.
        5.  **Complete the Task:** When the user's request has been fully addressed, call the 'finish' tool with a message summarizing what was done.

        User Request: "${prompt}"
        ${contextItemId ? `Context Item ID: "${contextItemId}"` : ''}
    `;

    const result: GenerateContentResponse = await getGenAI().models.generateContent({
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

    const call = result.functionCalls?.[0];
    const modelResponseContent = result.candidates?.[0]?.content ?? null;

    if (!call || !call.name) {
        console.warn("[Reasoner] Model did not return a function call. Assuming task is complete.");
        const textResponse = (result.text ?? "").trim();
        const planStep: PlanStep = {
            step: -1,
            tool: 'finish',
            args: { finalMessage: textResponse || "Task completed." },
            description: "Finish with a direct text response from the model.",
            status: 'pending'
        };
        return { planStep, modelResponseContent };
    }

    const nextStep: PlanStep = {
        step: history.filter(h => h.role === 'function').length + 1,
        description: `Call tool: ${call.name}`,
        tool: call.name,
        args: call.args,
        status: 'pending'
    };

    return { planStep: nextStep, modelResponseContent };
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
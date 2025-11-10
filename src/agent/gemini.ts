import { GoogleGenAI, FunctionDeclaration, Content, Type, GenerateContentResponse, FunctionCallingConfigMode  } from "@google/genai";
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PlanStep } from './types.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    throw new Error("Server is not configured with a GEMINI_API_KEY.");
}

const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

export interface DetectedIntent {
  strategy: 'SIMPLE_ACTION' | 'MEDIUM_ACTION' | 'COMPLEX_OR_GENERAL';
}

export interface NextStepResult {
    planStep: PlanStep | null;
    modelResponseContent: Content | null;
}

/**
 * Detects if the prompt is a general question, a simple action, or a medium/complex action.
 */
export const detectIntent = async (prompt: string): Promise<DetectedIntent> => {
    const tools: FunctionDeclaration[] = [
        {
            name: 'handleSimpleAction',
            description: 'Use for a very clear, specific, single-action command that requires only a few tools. Examples: "create a folder", "get item X", "what time is it?".',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'handleMediumAction',
            description: 'Use for a clear command that may require a few steps or a moderate number of tools. Examples: "find an image and copy it to a new folder", "update the content and metadata of a component".',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'handleComplexOrGeneralQuery',
            description: 'Use for broad, ambiguous, multi-part requests, or general conversational questions. This is the default choice if unsure. Examples: "find all components modified last week and add them to the marketing bundle", "what can you do?", "list all tools".',
            parameters: { type: Type.OBJECT, properties: {} }
        }
    ];

    const systemInstruction = `You are an expert intent strategist. Analyze the user's prompt and classify its complexity. You MUST call one of the provided functions. Default to handleComplexOrGeneralQuery if uncertain.`;

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
        if (call?.name === 'handleSimpleAction') {
            console.log("[IntentDetector] Strategy: SIMPLE_ACTION");
            return { strategy: 'SIMPLE_ACTION' };
        }
        if (call?.name === 'handleMediumAction') {
            console.log("[IntentDetector] Strategy: MEDIUM_ACTION");
            return { strategy: 'MEDIUM_ACTION' };
        }
        
        console.log("[IntentDetector] Strategy: COMPLEX_OR_GENERAL");
        return { strategy: 'COMPLEX_OR_GENERAL' };

    } catch (error) {
        console.error("[IntentDetector] Error detecting intent, defaulting to COMPLEX_OR_GENERAL:", error);
        return { strategy: 'COMPLEX_OR_GENERAL' };
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
    relevantTools: any[]
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

    const toolsForNextStep = [...formatToolsForGemini(relevantTools), finishTool];

    const systemInstruction = `
        You are an expert orchestrator for a CMS. Your goal is to fulfill the user's request. You have the flexibility to either call a tool OR respond directly with a text message if that is more appropriate (e.g., for a simple conversational question).

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
                functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO }
            },
            temperature: 0.0
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

export const MANDATORY_TOOLS = [
        'bulkReadItems', 'getItem', 'createItem', 'createPage', 'createSchema', 'createComponent',
        'createComponentSchema', 'search', 'getPublications', 'getCurrentTime', 'updateContent',
        'updateMetadata', 'updatePage', 'localizeItem'
    ];

export const selectRelevantTools = async (prompt: string, allTools: any[], maxTools: number): Promise<any[]> => {
    const toolLister: FunctionDeclaration = {
        name: 'setSelectedTools',
        description: 'Use this function to provide the list of additional tools relevant to the user\'s request.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                toolNames: {
                    type: Type.ARRAY,
                    description: 'An array of the names of the additional tools that are most relevant to the user\'s request.',
                    items: { type: Type.STRING }
                }
            },
            required: ['toolNames']
        }
    };

    // Filter out mandatory tools from the list the selector model will see
    const optionalTools = allTools.filter(t => !MANDATORY_TOOLS.includes(t.name));
    const simplifiedOptionalTools = optionalTools.map(t => ({ name: t.name, description: t.description }));

    const numToolsToSelect = maxTools - MANDATORY_TOOLS.length;
    if (numToolsToSelect <= 0) {
        console.log(`[ToolRouter] Tool budget (${maxTools}) met by mandatory tools. Selecting mandatory tools only.`);
        return allTools.filter(t => MANDATORY_TOOLS.includes(t.name) || t.name === 'finish');
    }

    const systemInstruction = `
        You are a tool routing expert. Your job is to analyze the user's request and select the most relevant tools.
        The following core tools are already included: ${MANDATORY_TOOLS.join(', ')}.
        From the list of available tools below, you must select the top ${numToolsToSelect} MOST RELEVANT *additional* tools that are likely to be needed.
        Do NOT re-select any of the core tools. You MUST call the 'setSelectedTools' function with the names of your selected additional tools.
    `;

    const fullPrompt = `
        User Request: "${prompt}"

        Available Additional Tools:
        ${JSON.stringify(simplifiedOptionalTools, null, 2)}
    `;

    try {
        const result = await genAI.models.generateContent({
            model: "gemini-2.5-pro",
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: { systemInstruction, tools: [{ functionDeclarations: [toolLister] }], toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } }, temperature: 0.0 }
        });

        const call = result.functionCalls?.[0];
        const finalToolNames = new Set<string>(MANDATORY_TOOLS);

        if (call?.name === 'setSelectedTools' && call.args?.toolNames) {
            const additionalToolNames = call.args.toolNames as string[];
            additionalToolNames.forEach(name => finalToolNames.add(name));
        } else {
             console.warn("[ToolRouter] Model did not select any additional tools.");
        }
        
        // Ensure 'finish' is always present
        finalToolNames.add('finish');

        console.log(`[ToolRouter] Selected ${finalToolNames.size} total tools.`);
        return allTools.filter(t => finalToolNames.has(t.name));

    } catch (error) {
        console.error("[ToolRouter] Error selecting relevant tools, falling back to mandatory tools:", error);
        return allTools.filter(t => MANDATORY_TOOLS.includes(t.name) || t.name === 'finish');
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
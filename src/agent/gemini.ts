import { GoogleGenerativeAI, FunctionDeclarationSchema } from "@google/generative-ai";
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PlanStep } from './types.js';

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
 * Tool Selection Agent
 */
export const selectRelevantTools = async (prompt: string, allTools: any[]): Promise<any[]> => {
    const toolSelectorModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: { temperature: 0.0 }
    });
    const toolSignatures = allTools.map(t => ({ name: t.name, description: t.description }));
    const selectionPrompt = `
        You are an intelligent tool selection agent. Based on the user's request, identify the specific tools required.
        Request: "${prompt}"
        Available tools: ${JSON.stringify(toolSignatures, null, 2)}
        Respond ONLY with a JSON array of the names of the most relevant tools. e.g., ["search", "getItem"].
        If the request is a general question, return an empty array.
    `;

    try {
        const result = await toolSelectorModel.generateContent(selectionPrompt);
        const responseText = result.response.text().trim().replace(/```json|```/g, '');
        const relevantToolNames = JSON.parse(responseText);
        if (!Array.isArray(relevantToolNames)) return allTools;

        const relevantTools = allTools.filter(t => relevantToolNames.includes(t.name));
        console.log(`[ToolSelector] Selected ${relevantTools.length} tools.`);
        return relevantTools.length > 0 ? relevantTools : allTools;
    } catch (error) {
        console.error("[ToolSelector] Error selecting tools, falling back to all tools:", error);
        return allTools;
    }
};

/**
 * Orchestrator/Planner Agent
 */
export const generatePlan = async (prompt: string, contextItemId: string | undefined, history: any[], relevantTools: any[]): Promise<PlanStep[]> => {
    const plannerModel = genAI.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: { responseMimeType: "application/json", temperature: 0.0 },
        systemInstruction: `You are an expert orchestrator for a CMS. Your role is to create a deterministic, step-by-step plan.
        - Decompose the user's request into a sequence of tool calls.
        - The arguments for each tool call must be in a property named 'args'.
        - Use the output of a previous step as input for a subsequent step using the 'outputVariable'. e.g., {'locationId': '\${folder.Id}'}. The value inside \${} is a path to a property in the JSON result of the step with that outputVariable.
        - Always use 'search' or 'getItem' to get context (like folder IDs) before creating or modifying items.
        - Your final output MUST be a JSON object with a single key "plan", which is an array of plan steps.`
    });

    const formattedTools = formatToolsForGemini(relevantTools);
    const fullPrompt = `
        User Request: "${prompt}"
        ${contextItemId ? `Context Item ID: "${contextItemId}"` : ''}
        Conversation History: ${JSON.stringify(history)}
        Available Tools: ${JSON.stringify(formattedTools, null, 2)}
        Generate the plan.
    `;

    const result = await plannerModel.generateContent(fullPrompt);
    const responseText = result.response.text();
    const planObject = JSON.parse(responseText);

    return planObject.plan.map((step: any, index: number) => {
        const newStep = { ...step }; // Create a copy to avoid mutation

        // If 'parameters' exists, move its content to 'args' and delete the original.
        if (newStep.parameters) {
            newStep.args = newStep.parameters;
            delete newStep.parameters;
        }

        // Ensure 'args' always exists as an object.
        if (!newStep.args) {
            newStep.args = {};
        }

        // Add the required orchestrator properties.
        newStep.step = index + 1;
        newStep.status = 'pending';

        return newStep;
    });
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

    // This prompt is now more direct as it receives cleaner data from the orchestrator.
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
        // The fallback now returns the cleaned-up output instead of a verbose object.
        return `Completed with result: ${toolOutput}`;
    }
};

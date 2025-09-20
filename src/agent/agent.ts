import http from 'node:http';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, FunctionDeclarationSchema } from "@google/generative-ai";
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const removeUnsupportedProperties = (schema: any): any => {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => removeUnsupportedProperties(item));
    }
    
    delete schema.$schema;
    delete schema.additionalProperties;
    
    if (schema.type && Array.isArray(schema.type)) {
        const primaryType = schema.type.find((t: string) => t !== 'null');
        if (primaryType) {
            schema.type = primaryType;
        }
    }

    for (const key in schema) {
        schema[key] = removeUnsupportedProperties(schema[key]);
    }

    return schema;
};

const READ_ONLY_TOOLS = [
    'echo',
    'getCurrentTime',
    'search',
    'getBatchOperationStatus',
    'getClassifiedItems',
    'getComponentTemplateLinks',
    'getDefaultModel',
    'getIsComponentTemplateRequired',
    'getItemById',
    'bulkReadItemsById',
    'getItemHistory',
    'getItemsInContainer',
    'getLockedItems',
    'getSchemaLinks',
    'getUsers',
    'readWordFileFromMultimediaComponent',
    'readExcelFileFromMultimediaComponent',
    'readTextFromPowerPointMultimediaComponent',
    'readPdfFileFromMultimediaComponent',
    'readImageDetailsFromMultimediaComponent',
    'getBluePrintHierarchy',
    'getPublications',
    'getPublicationTypes',
    'getCategories',
    'getKeywordsForCategory',
    'dependencyGraphForItem'
];

export async function handleAgentChat(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    tools: any[]
) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
        try {
            const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
            if (!GEMINI_API_KEY) {
                throw new Error("Server is not configured with a GEMINI_API_KEY.");
            }

            const { prompt, conversationId, context, history = [] } = JSON.parse(body);
            if (!prompt || !conversationId) {
                throw new Error("Request body must include 'prompt' and 'conversationId'.");
            }
            
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const geminiFormattedTools = tools.map(tool => {
                const zodSchema = z.object(tool.input);
                let jsonSchema = zodToJsonSchema(zodSchema);
                jsonSchema = removeUnsupportedProperties(jsonSchema);
                
                return {
                    name: tool.name,
                    description: tool.description,
                    parameters: jsonSchema as FunctionDeclarationSchema
                };
            });

            const currentDateTime = new Date().toISOString();
            const baseSystemInstruction = `You are an expert assistant for the Tridion Sites CMS.
Your role is orchestration, not creative writing. Be concise and deterministic in responses. Your primary goal is to help the user manage content by using the available tools. For any task that involves generating creative content (like marketing copy, product descriptions, or suggestions), you MUST use the 'generateContentFromPrompt' tool. Do not generate this content yourself.

When evaluating a request that lacks context (e.g., which item to modify or where to create new items), use the provided context item if available.
For complex requests, decompose them into a sequence of tool calls, but only report back the final result to the user — never intermediate steps.

CRITICAL SAFETY RULE: Before calling any tool that permanently deletes or irreversibly modifies content (e.g., deleteItem, batchDeleteItemsById), you must first ask the user for explicit confirmation. Clearly state what will be deleted, and do not proceed until the user affirms.

If a required tool parameter is missing (e.g., a Directory for a structure group, or a Schema for a component), ask the user for the missing information. Always clarify what is needed instead of abandoning the request.`;
            
            const finalSystemInstruction = `${baseSystemInstruction}
IMPORTANT: The current date and time is ${currentDateTime}. Use this for relative date queries like "today," "yesterday," "last week," or "last month." If the conversation has been ongoing for a while, or the user asks about a very recent timeframe (e.g., "in the last 5 minutes"), call the 'getCurrentTime' tool for accuracy.`;

            // Available models: https://ai.google.dev/gemini-api/docs/models
            const geminiAgent = genAI.getGenerativeModel({
                model: "gemini-2.5-flash",
                tools: [{ functionDeclarations: geminiFormattedTools }],
                systemInstruction: finalSystemInstruction,
                generationConfig: { temperature: 0.1 },
                safetySettings: [{
                    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: HarmBlockThreshold.BLOCK_NONE
                }]
            });
            
            const chat = geminiAgent.startChat({ history });

            let promptToSend = prompt;
            if (history.length === 0 && context?.itemId) {
                promptToSend = `The user is currently in the context of item ID '${context.itemId}'. Their first request is: "${prompt}"`;
                console.log(`[AGENT] New conversation started with context: ${context.itemId}`);
            }

            let result = await chat.sendMessage(promptToSend);
            let agentResponseText = '';
            let shouldInvalidateContext = false;

            const MAX_TURNS = 10;
            for (let turn = 0; turn < MAX_TURNS; turn++) {
                const response = result.response;
                const toolCalls = response.functionCalls();

                if (!toolCalls || toolCalls.length === 0) {
                    agentResponseText = response.text();
                    break;
                }

                // Check if the context ID was used in a relevant parameter.
                if (context?.itemId && !shouldInvalidateContext) {
                    const hasWriteOperation = toolCalls.some(call => !READ_ONLY_TOOLS.includes(call.name));
                    if (hasWriteOperation) {
                        shouldInvalidateContext = true;
                    }
                }

                console.log(`[AGENT] Turn ${turn + 1}: Executing ${toolCalls.length} tool(s)...`);

                const toolExecutionPromises = toolCalls.map(async (call) => {
                    const toolToExecute = tools.find(t => t.name === call.name);
                    if (!toolToExecute) {
                        return { functionResponse: { name: call.name, response: { error: `Tool '${call.name}' not found.` } } };
                    }
                    
                    try {
                        const agentContext = { request: req };
                        const toolResult = await toolToExecute.execute(call.args, agentContext);
                        let parsedResponse;
                        try {
                           parsedResponse = JSON.parse(toolResult.content[0].text);
                        } catch (e) {
                           parsedResponse = { result: toolResult.content[0].text };
                        }
                        return { functionResponse: { name: call.name, response: parsedResponse } };
                    } catch(e) {
                        const error = e instanceof Error ? e : new Error(String(e));
                        return { functionResponse: { name: call.name, response: { error: `Execution failed: ${error.message}` } } };
                    }
                });

                const toolResponses = await Promise.all(toolExecutionPromises);
                result = await chat.sendMessage(JSON.stringify(toolResponses));
            }

            if (!agentResponseText) {
                agentResponseText = "The agent finished its work without providing a final summary. You might want to ask for a status update.";
            }

            const updatedHistory = await chat.getHistory();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                content: [{ type: 'text', text: agentResponseText }],
                shouldInvalidateContext: shouldInvalidateContext,
                history: updatedHistory
            }));

        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            console.error("Agent Error:", error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Agent Error: ${error.message}` }));
        }
    });
}
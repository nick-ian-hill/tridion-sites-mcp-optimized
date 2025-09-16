import http from 'node:http';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// --- Global Error Handlers ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('----- UNHANDLED REJECTION -----');
    console.error('Reason:', reason);
    process.exit(1);
});
process.on('uncaughtException', (err, origin) => {
    console.error('----- UNCAUGHT EXCEPTION -----');
    console.error('Error:', err);
    process.exit(1);
});

// --- Tool Imports ---
import { batchLocalizeItemsById } from "./tools/batchLocalizeItemsById.js";
import { batchUnlocalizeItemsById } from "./tools/batchUnlocalizeItemsById.js";
import { bulkReadItemsById } from "./tools/bulkReadItemsById.js";
import { checkInItem } from "./tools/checkInItem.js";
import { checkOutItem } from "./tools/checkOutItem.js";
import { copyItem } from "./tools/copyItem.js";
import { createItem } from "./tools/createItem.js";
import { createPublication } from "./tools/createPublication.js";
import { createRootStructureGroup } from "./tools/createRootStructureGroup.js";
import { createSchema } from "./tools/createSchema.js";
import { deleteItem } from "./tools/deleteItem.js";
import { demoteItem } from "./tools/demoteItem.js";
import { dependencyGraphForItem } from "./tools/dependencyGraphForItem.js";
import { echo } from "./tools/echo.js";
import { getBluePrintHierarchy } from "./tools/getBluePrintHierarchy.js";
import { getCategories } from "./tools/getCategories.js";
import { getItemById } from "./tools/getItemById.js";
import { getItemsInContainer } from "./tools/getItemsInContainer.js";
import { getKeywordsForCategory } from "./tools/getKeywordsForCategory.js";
import { getPublications } from "./tools/getPublications.js";
import { getPublicationTypes } from "./tools/getPublicationTypes.js";
import { localizeItemById } from "./tools/localizeItemById.js";
import { moveItem } from "./tools/moveItem.js";
import { promoteItem } from "./tools/promoteItem.js";
import { search } from "./tools/search.js";
import { unlocalizeItemById } from "./tools/unlocalizeItemById.js";
import { undoCheckOutItem } from "./tools/undoCheckOutItem.js";
import { updateContentById } from "./tools/updateContentById.js";
import { updateItemById } from "./tools/updateItemById.js";
import { updatePublicationById } from "./tools/updatePublicationById.js";
import { updateMetadataById } from './tools/updateMetadataById.js';
import { getLockedItems } from './tools/getLockedItems.js';
import { getItemHistory } from './tools/getItemHistory.js';
import { rollbackItem } from './tools/rollbackItem.js';
import { getClassifiedItems } from './tools/getClassifiedItems.js';
import { batchDeleteItemsById } from './tools/batchDeleteItemsById.js';
import { batchClassify } from './tools/batchClassify.js';
import { batchUnclassify } from './tools/batchUnclassify.js';
import { batchCheckOut } from './tools/batchCheckOut.js';
import { batchCheckIn } from './tools/batchCheckIn.js';
import { batchUndoCheckOut } from './tools/batchUndoCheckOut.js';
import { getBatchOperationStatus } from './tools/getBatchOperationStatus.js';
import { createMultimediaComponentFromUrl } from './tools/createMultimediaComponentFromUrl.js';
import { getSchemaLinks } from './tools/getSchemaLinks.js';
import { createMultimediaComponentFromBase64 } from './tools/createMultimediaComponentFromBase64.js';
import { createMultimediaComponentFromPrompt } from './tools/createMultimediaComponentFromPrompt.js';
import { createPage } from './tools/createPage.js';
import { getDefaultModel } from './tools/getDefaultModel.js';
import { getComponentTemplateLinks } from './tools/getComponentTemplateLinks.js';
import { getIsComponentTemplateRequired } from './tools/getIsComponentTemplateRequired.js';
import { updatePage } from './tools/updatePage.js';
import { updateMultimediaComponentFromPrompt } from './tools/updateMultimediaComponentFromPrompt.js';
import { readWordFileFromMultimediaComponent } from './tools/readWordFileFromMultimediaComponent.js';
import { readExcelFileFromMultimediaComponent } from './tools/readExcelFileFromMultimediaComponent.js';
import { readTextFromPowerPointMultimediaComponent } from './tools/readTextFromPowerPointMultimediaComponent.js';
import { readPdfFileFromMultimediaComponent } from './tools/readPdfFileFromMultimediaComponent.js';
import { splitPowerPointMultimediaComponentIntoTextAndImages } from './tools/splitPowerPointMultimediaComponentIntoTextAndImages.js';
import { readImageDetailsFromMultimediaComponent } from './tools/readImageDetailsFromMultimediaComponent.js';
import { getUsers } from './tools/getUsers.js';

// --- Main Tools Array ---
const tools: any[] = [
    // General & System
    echo,
    search,
    // Read Operations
    getBatchOperationStatus,
    getClassifiedItems,
    getComponentTemplateLinks,
    getDefaultModel,
    getIsComponentTemplateRequired,
    getItemById,
    bulkReadItemsById,
    getItemHistory,
    getItemsInContainer,
    getLockedItems,
    getSchemaLinks,
    getUsers,
    readWordFileFromMultimediaComponent,
    readExcelFileFromMultimediaComponent,
    readTextFromPowerPointMultimediaComponent,
    readPdfFileFromMultimediaComponent,
    readImageDetailsFromMultimediaComponent,
    // Create Operations
    createItem,
    createMultimediaComponentFromPrompt,
    createMultimediaComponentFromBase64,
    createMultimediaComponentFromUrl,
    createPage,
    createPublication,
    createRootStructureGroup,
    createSchema,
    splitPowerPointMultimediaComponentIntoTextAndImages,
    // Classification
    batchClassify,
    batchUnclassify,
    // Update Operations
    updateItemById,
    updateContentById,
    updateMetadataById,
    updateMultimediaComponentFromPrompt,
    updatePage,
    updatePublicationById,
    // Item Actions (Move, Copy, Delete)
    moveItem,
    copyItem,
    deleteItem,
    batchDeleteItemsById,
    // BluePrinting & Localization
    getBluePrintHierarchy,
    localizeItemById,
    unlocalizeItemById,
    promoteItem,
    demoteItem,
    batchLocalizeItemsById,
    batchUnlocalizeItemsById,
    // Versioning
    batchCheckOut,
    batchCheckIn,
    batchUndoCheckOut,
    checkInItem,
    checkOutItem,
    rollbackItem,
    undoCheckOutItem,
    // List & Taxonomy
    getPublications,
    getPublicationTypes,
    getCategories,
    getKeywordsForCategory,
    dependencyGraphForItem,
];

// --- Setup for Gemini Agent (for UI Panel) ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const geminiFormattedTools = tools.map(tool => {
    const toolSchema = z.object(tool.input);
    const jsonSchema: any = zodToJsonSchema(toolSchema, { target: "openApi3", $refStrategy: "none" });
    if (jsonSchema.additionalProperties) delete jsonSchema.additionalProperties;
    return { name: tool.name, description: tool.description, parameters: jsonSchema };
});

const geminiAgent = genAI.getGenerativeModel({
    model: "gemini-1.5-flash-latest",
    tools: [{ functionDeclarations: geminiFormattedTools }],
});

// --- Setup for MCP Server (for VS Code Client) ---
const mcpServer = new McpServer({ name: "tridion-sites-mcp-server", version: "1.0.0" });
const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

tools.forEach(tool => {
    mcpServer.tool(tool.name, tool.description, tool.input, tool.execute as any);
});
mcpServer.connect(mcpTransport);

// --- Unified HTTP Server ---
const MCP_API_KEY = process.env.MCP_API_KEY || "demo-secret-key";

const httpServer = http.createServer((req, res) => {
    // --- CORS and OPTIONS Pre-flight handler ---
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8080');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
        res.writeHead(204);
        res.end();
        return;
    }

    // --- ROUTING LOGIC ---
    // A) Route for the UI's Gemini Agent
    if (req.url === '/agent/chat' && req.method === 'POST') {
        // ✅ API Key check is now inside this specific route
        if (req.headers['x-api-key'] !== MCP_API_KEY) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid API Key' }));
            return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                if (!GEMINI_API_KEY) throw new Error("Server is not configured with a GEMINI_API_KEY.");
                const { prompt } = JSON.parse(body);
                
                // Your mock response for debugging is preserved here
                const mockResult = {
                    response: {
                        functionCalls: () => [{
                            name: 'getDefaultModel',
                            args: { modelType: 'Folder', containerId: 'tcm:5-1-2' }
                        }],
                        text: () => '', // Not used when a tool is called, but good to have.
                    }
                };

                // const chat = geminiAgent.startChat();
                // const result = await chat.sendMessage(prompt);
                const result = mockResult;
                const response = result.response;
                const toolCalls = response.functionCalls();

                let agentResponse;
                if (toolCalls && toolCalls.length > 0) {
                    const call = toolCalls[0];
                    const toolToExecute = tools.find(t => t.name === call.name);

                    if (toolToExecute) {
                        const agentContext = { request: req };
                        agentResponse = await toolToExecute.execute(call.args, agentContext);
                    } else {
                        throw new Error(`Agent requested unknown tool: ${call.name}`);
                    }
                } else {
                    agentResponse = { content: [{ type: 'text', text: response.text() }] };
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(agentResponse));
            } catch (e) {
                const error = e instanceof Error ? e : new Error(String(e));
                console.error("Agent Error:", error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Agent Error: ${error.message}` }));
            }
        });
        return;
    }

    // B) Fallback Route for the VS Code MCP Client (no API key check)
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const parsedBody = JSON.parse(body);
                mcpTransport.handleRequest(req, res, parsedBody);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    } else {
        mcpTransport.handleRequest(req, res);
    }
});

httpServer.on('error', (err) => {
    console.error('----- HTTP SERVER ERROR -----');
    console.error(err);
});

const port = 8090;
httpServer.listen(port, () => {
    console.log(`Tridion Sites MCP Server listening on http://localhost:${port}`);
    if (MCP_API_KEY === 'demo-secret-key') {
        console.warn('Warning: Running with a default demo API key. Set the MCP_API_KEY environment variable for production.');
    }
});
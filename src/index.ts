import http from 'node:http';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleAgentChat } from './agent/agent.js';

// --- Tool Imports ---
import { batchLocalizeItems } from "./tools/batchLocalizeItems.js";
import { batchUnlocalizeItems } from "./tools/batchUnlocalizeItems.js";
import { bulkReadItems } from "./tools/bulkReadItems.js";
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
import { getCurrentTime } from './tools/getCurrentTime.js';
import { getBluePrintHierarchy } from "./tools/getBluePrintHierarchy.js";
import { getCategories } from "./tools/getCategories.js";
import { getItem } from "./tools/getItem.js";
import { getItemsInContainer } from "./tools/getItemsInContainer.js";
import { getKeywordsForCategory } from "./tools/getKeywordsForCategory.js";
import { getPublications } from "./tools/getPublications.js";
import { getPublicationTypes } from "./tools/getPublicationTypes.js";
import { localizeItem } from "./tools/localizeItem.js";
import { moveItem } from "./tools/moveItem.js";
import { promoteItem } from "./tools/promoteItem.js";
import { search } from "./tools/search.js";
import { unlocalizeItem } from "./tools/unlocalizeItem.js";
import { undoCheckOutItem } from "./tools/undoCheckOutItem.js";
import { updateContent } from "./tools/updateContent.js";
import { updateItemProperties } from "./tools/updateItemProperties.js";
import { updatePublication } from "./tools/updatePublication.js";
import { updateMetadata } from './tools/updateMetadata.js';
import { getLockedItems } from './tools/getLockedItems.js';
import { getItemHistory } from './tools/getItemHistory.js';
import { rollbackItem } from './tools/rollbackItem.js';
import { getClassifiedItems } from './tools/getClassifiedItems.js';
import { batchDeleteItems } from './tools/batchDeleteItems.js';
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
import { readExcelFileFromMultimediaComponent } from './tools/readExcelFileFromMultimediaComponent.js';
import { readTextFromPowerPointMultimediaComponent } from './tools/readTextFromPowerPointMultimediaComponent.js';
import { readPdfFileFromMultimediaComponent } from './tools/readPdfFileFromMultimediaComponent.js';
import { splitPowerPointMultimediaComponentIntoTextAndImages } from './tools/splitPowerPointMultimediaComponentIntoTextAndImages.js';
import { readImageDetailsFromMultimediaComponent } from './tools/readImageDetailsFromMultimediaComponent.js';
import { readTextFromWordMultimediaComponent } from './tools/readTextFromWordMultimediaComponent.js';
import { splitWordMultimediaComponentIntoTextAndImages } from './tools/splitWordMultimediaComponentIntoTextAndImages.js';
import { generateContentFromPrompt } from './tools/generateContentFromPrompt.js';
import { batchClassification } from './tools/batchClassification.js';
import { classify } from './tools/classify.js';
import { updateSchemaFieldProperties } from './tools/updateSchemaFieldProperties.js';
import { getActivities } from './tools/getActivities.js';
import { getProcessDefinitions } from './tools/getProcessDefinitions.js';
import { startActivity } from './tools/startActivity.js';
import { startWorkflow } from './tools/startWorkflow.js';
import { finishActivity } from './tools/finishActivity.js';
import { getUserProfile } from './tools/getUserProfile.js';
import { updateUserProfile } from './tools/updateUserProfile.js';
import { createProcessDefinition } from './tools/createProcessDefinition.js';
import { getMultimediaTypes } from './tools/getMultimediaTypes.js';
import { requestNavigation } from './tools/requestNavigation.js';
import { requestOpenInEditor } from './tools/requestOpenInEditor.js';
import { getUsers } from './tools/getUsers.js';

const tools: any[] = [
    // UI Navigation
    requestNavigation,
    requestOpenInEditor,
    // General & System
    echo,
    getCurrentTime,
    generateContentFromPrompt,
    search,
    // Read Operations
    getBatchOperationStatus,
    getClassifiedItems,
    getComponentTemplateLinks,
    getDefaultModel,
    getIsComponentTemplateRequired,
    getItem,
    bulkReadItems,
    getItemHistory,
    getItemsInContainer,
    getLockedItems,
    getMultimediaTypes,
    getSchemaLinks,
    getUsers,
    getUserProfile,
    readTextFromWordMultimediaComponent,
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
    splitWordMultimediaComponentIntoTextAndImages,
    // Classification
    classify,
    batchClassification,
    // Update Operations
    updateItemProperties,
    updateContent,
    updateMetadata,
    updateMultimediaComponentFromPrompt,
    updatePage,
    updatePublication,
    updateSchemaFieldProperties,
    updateUserProfile,
    // Item Actions (Move, Copy, Delete)
    moveItem,
    copyItem,
    deleteItem,
    batchDeleteItems,
    // BluePrinting & Localization
    getBluePrintHierarchy,
    localizeItem,
    unlocalizeItem,
    promoteItem,
    demoteItem,
    batchLocalizeItems,
    batchUnlocalizeItems,
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
    // Workflow
    getActivities,
    getProcessDefinitions,
    startActivity,
    startWorkflow,
    finishActivity,
    createProcessDefinition,
];

const mcpServer = new McpServer({ name: "tridion-sites-mcp-server", version: "1.0.0" });
const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
tools.forEach(tool => mcpServer.tool(tool.name, tool.description, tool.input, tool.execute as any));
mcpServer.connect(mcpTransport);
const MCP_API_KEY = process.env.MCP_API_KEY || "demo-secret-key";

const httpServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8080');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
        res.writeHead(204);
        res.end();
        return;
    }

    // Agent Endpoint for UI (Streaming)
    if (req.url?.startsWith('/agent/chat-stream') && req.method === 'POST') {
                if (req.headers['x-api-key'] !== MCP_API_KEY) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid API Key' }));
            return;
        }
        handleAgentChat(req, res, tools, true);
        return;
    }

    // Agent Endpoint for CLI/IDE (Synchronous)
    if (req.url === '/agent/chat' && req.method === 'POST') {
                if (req.headers['x-api-key'] !== MCP_API_KEY) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid API Key' }));
            return;
        }
        handleAgentChat(req, res, tools, false);
        return;
    }

    // Fallback for VS Code MCP Client (Direct Tool Execution)
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                mcpTransport.handleRequest(req, res, JSON.parse(body));
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
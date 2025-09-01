
import http from 'node:http';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Tool Imports
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

const server = new McpServer({
  name: "mcp-test-server",
  version: "1.0.0",
});

const tools: any[] = [
  // General & System
  echo,
  search,

  // Read Operations
  getBatchOperationStatus,
  getClassifiedItems,
  getItemById,
  bulkReadItemsById,
  getItemHistory,
  getItemsInContainer,
  getLockedItems,
  getSchemaLinks,
  
  // Create Operations
  createItem,
  createMultimediaComponentFromPrompt,
  createMultimediaComponentFromBase64,
  createMultimediaComponentFromUrl,
  createPublication,
  createRootStructureGroup,
  createSchema,

  // Classification
  batchClassify,
  batchUnclassify,
  
  // Update Operations
  updateItemById,
  updateContentById,
  updateMetadataById,
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

tools.forEach(tool => {
  server.tool(tool.name, tool.description, tool.input, tool.execute as any);
});

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});
server.connect(transport);

const httpServer = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsedBody = JSON.parse(body);
        transport.handleRequest(req, res, parsedBody);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else {
    transport.handleRequest(req, res);
  }
});

const port = 8090;
httpServer.listen(port, () => {});
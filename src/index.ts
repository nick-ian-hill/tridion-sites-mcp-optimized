import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
import { getDynamicItemById } from "./tools/getDynamicItemById.js";
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
import { updateComponentById } from "./tools/updateComponentById.js";
import { updateItemById } from "./tools/updateItemById.js";
import { updatePublicationById } from "./tools/updatePublicationById.js";

const server = new McpServer({
  name: "tridion-sites-mcp-server",
  version: "1.0.0",
});

const tools: any[] = [
  // General & System
  echo,
  search,

  // Read Operations
  getItemById,
  getDynamicItemById,
  bulkReadItemsById,
  getItemsInContainer,
  
  // Create Operations
  createItem,
  createPublication,
  createRootStructureGroup,
  createSchema,
  
  // Update Operations
  updateItemById,
  updateComponentById,
  updatePublicationById,
  
  // Item Actions (Move, Copy, Delete)
  moveItem,
  copyItem,
  deleteItem,

  // BluePrinting & Localization
  getBluePrintHierarchy,
  localizeItemById,
  unlocalizeItemById,
  promoteItem,
  demoteItem,
  batchLocalizeItemsById,
  batchUnlocalizeItemsById,

  // Versioning
  checkInItem,
  checkOutItem,
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

const transport = new StdioServerTransport();
server.connect(transport);

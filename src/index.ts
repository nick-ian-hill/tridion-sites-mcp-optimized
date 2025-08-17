import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bulkReadItemsById } from "./tools/bulkReadItemsById.js";
import { createItem } from "./tools/createItem.js";
import { dependencyGraphForItem } from "./tools/dependencyGraphForItem.js";
import { echo } from "./tools/echo.js";
import { getDynamicItemById } from "./tools/getDynamicItemById.js";
import { getItemById } from "./tools/getItemById.js";
import { getPublications } from "./tools/getPublications.js";
import { search } from "./tools/search.js";
import { updateComponentById } from "./tools/updateComponentById.js";
import { updateItemById } from "./tools/updateItemById.js";
import { localizeItemById } from "./tools/localizeItemById.js";
import { unlocalizeItemById } from "./tools/unlocalizeItemById.js";
import { batchLocalizeItemsById } from "./tools/batchLocalizeItemsById.js";
import { batchUnlocalizeItemsById } from "./tools/batchUnlocalizeItemsById.js";
import { getCategories } from "./tools/getCategories.js";
import { getKeywordsForCategory } from "./tools/getKeywordsForCategory.js";
import { getItemsInContainer } from "./tools/getItemsInContainer.js";
import { createSchema } from "./tools/createSchema.js";
import { createPublication } from "./tools/createPublication.js";
import { getBluePrintHierarchy } from "./tools/getBluePrintHierarchy.js";
import { moveItem } from "./tools/moveItem.js";
import { copyItem } from "./tools/copyItem.js";
import { updatePublicationById } from "./tools/updatePublicationById.js";
import { getPublicationTypes } from "./tools/getPublicationTypes.js";
import { createRootStructureGroup } from "./tools/createRootStructureGroup.js";

const server = new McpServer({
  name: "tridion-sites-mcp-server",
  version: "1.0.0",
});

const tools: any[] = [
  echo,
  bulkReadItemsById,
  getBluePrintHierarchy,
  getCategories,
  getDynamicItemById,
  getItemById,
  getItemsInContainer,
  getKeywordsForCategory,
  getPublications,
  getPublicationTypes,
  copyItem,
  moveItem,
  updateComponentById,
  updateItemById,
  updatePublicationById,
  createItem,
  createPublication,
  createRootStructureGroup,
  createSchema,
  search,
  dependencyGraphForItem,
  localizeItemById,
  unlocalizeItemById,
  batchLocalizeItemsById,
  batchUnlocalizeItemsById,
];

tools.forEach(tool => {
  server.tool(tool.name, tool.description, tool.input, tool.execute as any);
});

const transport = new StdioServerTransport();
server.connect(transport);

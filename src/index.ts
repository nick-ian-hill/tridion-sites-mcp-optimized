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

const server = new McpServer({
  name: "tridion-sites-mcp-server",
  version: "1.0.0",
});

const tools: any[] = [
  echo,
  getItemById,
  getDynamicItemById,
  bulkReadItemsById,
  updateComponentById,
  search,
  createItem,
  updateItemById,
  dependencyGraphForItem,
  getPublications,
];

tools.forEach(tool => {
  server.tool(tool.name, tool.description, tool.input, tool.execute as any);
});

const transport = new StdioServerTransport();
server.connect(transport);

import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

const escapeHTML = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, '\\"');
const convertGraphToDot = (nodes: any[], edges: any[]): string => {
    const parts: string[] = [];
    parts.push('digraph Blueprint {');
    parts.push('  rankdir="TB";');
    parts.push('  bgcolor="transparent";');
    parts.push('  node [shape=plaintext, fontname="Arial, Helvetica, sans-serif"];');
    parts.push('  edge [arrowhead=vee, color="#F50057"];');
    parts.push('');
    nodes.forEach(node => {
        let textLabel = escapeHTML(node.label);
        const itemTitle = node.data?.item?.title;
        if (itemTitle && node.label !== itemTitle) {
            textLabel += `<BR/>(${escapeHTML(itemTitle)})`;
        }
        const htmlLabel = `
<TABLE BORDER="2" COLOR="#F50057" CELLBORDER="0" CELLSPACING="0" CELLPADDING="1" BGCOLOR="#FFFFFF">
  <TR>
    <TD>
      <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="3" BGCOLOR="#4D2C91">
        <TR>
          <TD ALIGN="CENTER">
            <FONT COLOR="#FFFFFF">${textLabel}</FONT>
          </TD>
        </TR>
      </TABLE>
    </TD>
  </TR>
</TABLE>`;
        parts.push(`  "${node.id}" [label=<${htmlLabel}>];`);
    });
    parts.push('');
    edges.forEach(edge => {
        parts.push(`  "${edge.source}" -> "${edge.target}";`);
    });
    parts.push('}');
    return parts.join("\n");
};

export const getBluePrintHierarchy = {
    name: "getBluePrintHierarchy",
    description: `Retrieves the BluePrint hierarchy for a specified Content Manager item.
The hierarchy shows the parent and child relationships for the item within the BluePrint, which is fundamental for content inheritance and reuse.

### Output Structure (JsonGraph)
By default, this tool returns a 'JsonGraph' object containing a 'graph' property.
IMPORTANT: The 'nodes' and 'edges' properties are **ARRAYS**, not Dictionaries/Maps.
The 'data.item' property of each node respects the 'includeProperties' or 'details' parameters, allowing you to request specific fields (like 'BluePrintInfo' or 'VersionInfo') for every item in the hierarchy in a single call.

Example Structure:
{
  "graph": {
    "nodes": [
      { 
        "id": "tcm:0-2-1", 
        "label": "Child Pub", 
        "data": { 
           "item": { 
              "Id": "tcm:2-123-64", 
              "Title": "My Page", 
              ... // Requested properties appear here
           } 
        } 
      }
    ],
    "edges": [
      { "source": "tcm:0-1-1", "target": "tcm:0-2-1", "relation": "has child" }
    ]
  }
}

This tool should be used before performing BluePrinting operations like 'localizeItem', 'unlocalizeItem', 'promoteItem', or 'demoteItem' to understand the context and identify valid parent/child Publications.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The TCM URI of the item for which to retrieve the BluePrint hierarchy."),
        outputFormat: z.enum(["Raw", "JsonGraph", "Svg"]).optional().default("JsonGraph").describe("Specifies the output format. Defaults to 'JsonGraph', which formats the data for efficient graph processing (Best for scripts). 'Raw' returns the nested API JSON. 'Svg' generates and returns an SVG image of the hierarchy."),
        details: z.enum(["IdAndTitle", "CoreDetails", "AllDetails"]).default("IdAndTitle").optional().describe(`Specifies a predefined level of detail.
- "IdAndTitle": Returns only the ID and Title of each item.
- "CoreDetails": Returns the main properties, excluding verbose security and link-related information.
- "AllDetails": Returns all available properties for each item. Only select "AllDetails" if you absolutely need full details about the returned items.`),
        includeProperties: z.array(z.string()).optional().describe(`An array of property names to include in the response for custom control (e.g., Parents.IdRef, Children.Title, BluePrintInfo, VersionInfo). If used, 'details' is ignored. Prefer this option to avoid returning unnecessary data and limit token usage.`),
    },
    execute: async ({ itemId, outputFormat = "JsonGraph", details = "IdAndTitle", includeProperties }: { itemId: string; outputFormat: "Raw" | "JsonGraph" | "Svg"; details?: "IdAndTitle" | "CoreDetails" | "AllDetails", includeProperties?: string[] }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const hasCustomProperties = includeProperties && includeProperties.length > 0;
            const isMinimalDetails =
                (outputFormat === 'JsonGraph' || outputFormat === 'Svg') ||
                (details === 'IdAndTitle' && !hasCustomProperties);

            const apiDetails = isMinimalDetails ? 'IdAndTitleOnly' : 'Contentless';

            const escapedItemId = itemId.replace(':', '_');
            const response = await authenticatedAxios.get(`/items/${escapedItemId}/bluePrintHierarchy`, {
                params: { details: apiDetails }
            });

            if (response.status !== 200) {
                return handleUnexpectedResponse(response);
            }

            if (outputFormat === "Raw") {
                const finalData = filterResponseData({ responseData: response.data, details, includeProperties });
                const formattedFinalData = formatForAgent(finalData);
                return { content: [{ type: "text", text: JSON.stringify(formattedFinalData, null, 2) }] };
            }

            const rawData = response.data;
            const nodes = new Map<string, any>();
            const edges: { source: string; target: string; relation: string; }[] = [];

            rawData.Items.forEach((bpNode: any) => {
                const pubId = bpNode.ContextRepositoryId;

                const filteredItem = filterResponseData({ 
                    responseData: bpNode.Item, 
                    details, 
                    includeProperties 
                });

                if (!nodes.has(pubId)) {
                    nodes.set(pubId, {
                        id: pubId,
                        label: bpNode.ContextRepositoryTitle,
                        data: { item: filteredItem }
                    });
                }
            });

            rawData.Items.forEach((bpNode: any) => {
                const childPubId = bpNode.ContextRepositoryId;
                if (bpNode.Parents) {
                    bpNode.Parents.forEach((parent: any) => {
                        const parentPubId = parent.IdRef;
                        if (!nodes.has(parentPubId)) {
                            // For parent nodes not in the primary list, we create a stub.
                            nodes.set(parentPubId, { id: parentPubId, label: parent.Title });
                        }
                        const uniqueEdgeId = `${parentPubId}->${childPubId}`;
                        if (!edges.some(e => `${e.source}->${e.target}` === uniqueEdgeId)) {
                            edges.push({ source: parentPubId, target: childPubId, relation: "has child" });
                        }
                    });
                }
            });

            if (outputFormat === 'JsonGraph') {
                const graph = {
                    graph: {
                        directed: true,
                        type: "BluePrintHierarchy",
                        label: `BluePrint Hierarchy for ${itemId}`,
                        nodes: Array.from(nodes.values()),
                        edges
                    }
                };
                return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] };
            }

            if (outputFormat === 'Svg') {
                const { instance } = await import("@viz-js/viz");
                const dotString = convertGraphToDot(Array.from(nodes.values()), edges);
                const viz = await instance();
                const svgOutput = await viz.renderString(dotString, { format: "svg", engine: "dot" });
                
                const jsonResponse = {
                    type: "SvgImage",
                    Id: itemId,
                    SvgContent: svgOutput
                };

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(jsonResponse, null, 2)
                    }],
                };
            }

            const errorResponse = {
                type: 'Error',
                Message: "Invalid output format specified."
            };
            return { content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }], errors: [] };

        } catch (error) {
            return handleAxiosError(error, `Failed to process BluePrint hierarchy request for item ${itemId}`);
        }
    }
};
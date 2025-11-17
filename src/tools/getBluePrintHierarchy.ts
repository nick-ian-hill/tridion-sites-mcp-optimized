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
        if (node.metadata?.item?.title && node.label !== node.metadata.item.title) {
            const itemTitle = escapeHTML(node.metadata.item.title);
            textLabel += `<BR/>(${itemTitle})`;
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
    description: `Retrieves the BluePrint hierarchy for a specified Content Manager item. The hierarchy shows the parent and child relationships for the item within the BluePrint, which is fundamental for content inheritance and reuse.
This tool should be used before performing BluePrinting operations like 'localizeItem', 'unlocalizeItem', 'promoteItem', or 'demoteItem' to understand the context and identify valid parent/child Publications.
IMPORTANT: Requesting a high level of detail for many items can be slow. Prefer 'details: "IdAndTitle"' or 'includeProperties' for efficiency.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The TCM URI of the item for which to retrieve the BluePrint hierarchy."),
        outputFormat: z.enum(["Raw", "JsonGraph", "Svg"]).optional().default("Raw").describe("Specifies the output format. 'Raw' returns the API JSON. 'JsonGraph' formats the data for graph processing. 'Svg' generates and returns an SVG image of the hierarchy."),
        details: z.enum(["IdAndTitle", "CoreDetails", "AllDetails"]).default("IdAndTitle").optional().describe(`Specifies a predefined level of detail. This is ignored if outputFormat is 'JsonGraph' or 'Svg'.
- "IdAndTitle": Returns only the ID and Title of each item.
- "CoreDetails": Returns the main properties, excluding verbose security and link-related information.
- "AllDetails": Returns all available properties for each item. Only select "AllDetails" if you absolutely need full details about the returned items.`),
        includeProperties: z.array(z.string()).optional().describe(`An array of property names to include in the response for custom control (e.g., Parents.IdRef, Children.Title). If used, 'details' is ignored. This is ignored if outputFormat is 'JsonGraph' or 'Svg'. Prefer this option to avoid returning unnecessary data and limit token usage.`),
    },
    execute: async ({ itemId, outputFormat = "Raw", details = "IdAndTitle", includeProperties }: { itemId: string; outputFormat: "Raw" | "JsonGraph" | "Svg"; details?: "IdAndTitle" | "CoreDetails" | "AllDetails", includeProperties?: string[] }, context: any) => {
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
                if (!nodes.has(pubId)) {
                    nodes.set(pubId, {
                        id: pubId,
                        label: bpNode.ContextRepositoryTitle,
                        metadata: { item: { id: bpNode.Item.Id, title: bpNode.Item.Title } }
                    });
                }
            });

            rawData.Items.forEach((bpNode: any) => {
                const childPubId = bpNode.ContextRepositoryId;
                if (bpNode.Parents) {
                    bpNode.Parents.forEach((parent: any) => {
                        const parentPubId = parent.IdRef;
                        if (!nodes.has(parentPubId)) {
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
import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

/**
 * Escapes special HTML characters for Graphviz HTML-like labels.
 */
const escapeHTML = (s: string): string =>
    s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, '\\"');

/**
 * Converts a graph structure (nodes and edges) into the DOT language format.
 */
const convertGraphToDot = (nodes: any[], edges: any[]): string => {
    const parts: string[] = [];
    parts.push('digraph Blueprint {');
    parts.push('  rankdir="TB";');
    parts.push('  bgcolor="transparent";');

    // Minimal global styles
    parts.push('  node [shape=plaintext, fontname="Arial, Helvetica, sans-serif"];');
    parts.push('  edge [arrowhead=vee, color="#F50057"];');
    parts.push('');

    // Nodes
    nodes.forEach(node => {
        let textLabel = escapeHTML(node.label);
        if (node.metadata?.item?.title && node.label !== node.metadata.item.title) {
            const itemTitle = escapeHTML(node.metadata.item.title);
            textLabel += `<BR/>(${itemTitle})`;
        }

        // Double-table structure for border → gap → fill
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

    // Edges (parent → child)
    edges.forEach(edge => {
        parts.push(`  "${edge.source}" -> "${edge.target}";`);
    });

    parts.push('}');
    return parts.join("\n");
};

export const getBluePrintHierarchy = {
    name: "getBluePrintHierarchy",
    description: "Retrieves the BluePrint hierarchy for a specified Content Manager item. The hierarchy shows the parent and child relationships for the item within the BluePrint, which is fundamental for content inheritance and reuse.",
    input: {
        itemId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The TCM URI of the item for which to retrieve the BluePrint hierarchy."),
        outputFormat: z.enum(["Raw", "JsonGraph", "Svg"]).optional().default("Raw").describe("Specifies the output format. 'Raw' returns the API JSON. 'JsonGraph' formats the data for graph processing. 'Svg' generates and returns an SVG image of the hierarchy."),
        details: z.enum(["IdAndTitleOnly", "WithApplicableActions", "Contentless"]).optional().default("Contentless").describe("Specifies the level of detail for the items returned in the hierarchy. This is ignored if outputFormat is 'JsonGraph' or 'Svg' (which use 'IdAndTitleOnly')."),
    },
    execute: async ({ itemId, outputFormat, details }: { itemId: string; outputFormat: "Raw" | "JsonGraph" | "Svg"; details: "IdAndTitleOnly" | "WithApplicableActions" | "Contentless" }) => {
        try {
            const apiDetails = (outputFormat === 'JsonGraph' || outputFormat === 'Svg') ? 'IdAndTitleOnly' : details;

            const escapedItemId = itemId.replace(':', '_');
            const response = await authenticatedAxios.get(`/items/${escapedItemId}/bluePrintHierarchy`, {
                params: { details: apiDetails }
            });

            if (response.status !== 200) {
                return { content: [], errors: [{ message: `Failed to retrieve BluePrint hierarchy. Status: ${response.status}, Message: ${response.statusText}` }] };
            }

            const rawData = response.data;

            if (outputFormat === "Raw") {
                return { content: [{ type: "text", text: JSON.stringify(rawData, null, 2) }] };
            }

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
                        // Parent points to child
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
                // Dynamic import for ESM
                const { instance } = await import("@viz-js/viz");

                const dotString = convertGraphToDot(Array.from(nodes.values()), edges);
                const viz = await instance();
                const svgOutput = await viz.renderString(dotString, { format: "svg", engine: "dot" });

                return {
                    content: [{
                        type: "text",
                        text: `Here is the SVG representation of the BluePrint hierarchy for ${itemId}:\n\`\`\`svg\n${svgOutput}\n\`\`\``
                    }],
                };
            }

            return { content: [], errors: [{ message: "Invalid output format specified." }] };

        } catch (error) {
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return { content: [], errors: [{ message: `Failed to process BluePrint hierarchy request for item ${itemId}: ${errorMessage}` }] };
        }
    }
};

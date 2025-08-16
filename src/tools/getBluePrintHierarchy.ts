import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

/**
 * Converts a graph structure (nodes and edges) into the DOT language format.
 */
const convertGraphToDot = (nodes: any[], edges: any[]): string => {
    let dot = 'digraph Blueprint {\n';
    dot += '  rankdir="TB";\n';
    dot += '  bgcolor="transparent";\n';
    dot += '  node [shape=box, style="filled", fillcolor="#4D2C91", fontcolor="#FFFFFF", color="#F50057", fontname="Arial"];\n';
    dot += '  edge [arrowhead=vee, color="#F50057"];\n\n';

    nodes.forEach(node => {
        let label = node.label.replace(/"/g, '\\"');
        if (node.metadata?.item?.title && node.label !== node.metadata.item.title) {
            const itemTitle = node.metadata.item.title.replace(/"/g, '\\"');
            label += `\\n(${itemTitle})`;
        }
        dot += `  "${node.id}" [label="${label}"];\n`;
    });

    dot += '\n';

    edges.forEach(edge => {
        dot += `  "${edge.target}" -> "${edge.source}";\n`;
    });

    dot += '}';
    return dot;
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
                        const uniqueEdgeId = `${childPubId}->${parentPubId}`;
                        if (!edges.some(e => `${e.source}->${e.target}` === uniqueEdgeId)) {
                           edges.push({ source: childPubId, target: parentPubId, relation: "is child of" });
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

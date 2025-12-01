import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";

interface NodeLayout {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
    subLabel: string;
    color: string;
    isLocalized: boolean;
}

const truncateText = (text: string, maxLength: number): string => {
    if (!text) return "";
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + "...";
};

const generateSvg = (nodes: any[], edges: any[]): string => {
    // Configuration
    const NODE_WIDTH = 250;
    const NODE_HEIGHT = 60;
    const HORIZONTAL_GAP = 120;
    const VERTICAL_GAP = 20;    
    const PADDING = 40;
    const CORNER_RADIUS = 4;
    const HEADER_HEIGHT = 24;

    // 1. Build Adjacency Map & Calculate Ranks
    const nodeMap = new Map<string, any>(nodes.map(n => [n.id, n]));
    const ranks = new Map<string, number>();
    
    nodes.forEach(n => ranks.set(n.id, 0));

    for (let i = 0; i < 50; i++) {
        let changed = false;
        edges.forEach(e => {
            const pRank = ranks.get(e.source) || 0;
            const cRank = ranks.get(e.target) || 0;
            if (cRank <= pRank) {
                ranks.set(e.target, pRank + 1);
                changed = true;
            }
        });
        if (!changed) break; 
    }

    // 2. Group by Rank & Sort
    const columns: string[][] = [];
    nodes.forEach(n => {
        const r = ranks.get(n.id) || 0;
        if (!columns[r]) columns[r] = [];
        columns[r].push(n.id);
    });

    columns.forEach(col => col.sort((a, b) => {
        const titleA = nodeMap.get(a)?.label || "";
        const titleB = nodeMap.get(b)?.label || "";
        return titleA.localeCompare(titleB);
    }));

    // 3. Layout Calculation
    const layoutNodes = new Map<string, NodeLayout>();
    let maxGraphHeight = 0;
    let maxGraphWidth = columns.length * (NODE_WIDTH + HORIZONTAL_GAP);

    columns.forEach((colIds, rankIndex) => {
        const x = PADDING + (rankIndex * (NODE_WIDTH + HORIZONTAL_GAP));
        
        colIds.forEach((nodeId, rowIndex) => {
            const y = PADDING + (rowIndex * (NODE_HEIGHT + VERTICAL_GAP));
            const rawNode = nodeMap.get(nodeId);
            
            const item = rawNode.data?.item;
            const isLocalized = item?.BluePrintInfo?.IsLocalized;
            const itemTitle = item?.Title || "";
            const itemId = item?.Id || "";
            const label = rawNode.label;

            let subLabel = "";
            
            if (itemId.endsWith("-1")) {
                subLabel = itemId;
            } else {
                subLabel = itemTitle;
            }
            
            const color = isLocalized ? "#2E7D32" : "#4D2C91";

            layoutNodes.set(nodeId, {
                id: nodeId,
                x,
                y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
                label: truncateText(label, 32),
                subLabel: truncateText(subLabel, 40),
                color,
                isLocalized
            });

            if (y + NODE_HEIGHT > maxGraphHeight) maxGraphHeight = y + NODE_HEIGHT;
        });
    });

    // 4. Generate SVG Strings
    let svgContent = "";

    // -- Draw Edges (Smooth Bézier Curves, No Arrows) --
    edges.forEach(e => {
        const source = layoutNodes.get(e.source);
        const target = layoutNodes.get(e.target);
        if (!source || !target) return;

        const x1 = source.x + source.width;
        const y1 = source.y + (source.height / 2);
        const x2 = target.x;
        const y2 = target.y + (target.height / 2);

        const c1x = x1 + (HORIZONTAL_GAP / 2);
        const c1y = y1;
        const c2x = x2 - (HORIZONTAL_GAP / 2);
        const c2y = y2;

        svgContent += `<path d="M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}" stroke="#999" stroke-width="1.5" fill="none" stroke-opacity="0.6" />\n`;
    });

    // -- Draw Nodes --
    layoutNodes.forEach(n => {
        svgContent += `<g transform="translate(${n.x},${n.y})">`;
        
        // Main Box Border (White Fill, Colored Stroke)
        svgContent += `<rect width="${n.width}" height="${n.height}" rx="${CORNER_RADIUS}" fill="white" stroke="${n.color}" stroke-width="2"/>`;
        
        // Colored Header Bar
        const headerPath = `
            M 0,${CORNER_RADIUS} 
            Q 0,0 ${CORNER_RADIUS},0 
            L ${n.width - CORNER_RADIUS},0 
            Q ${n.width},0 ${n.width},${CORNER_RADIUS} 
            L ${n.width},${HEADER_HEIGHT} 
            L 0,${HEADER_HEIGHT} 
            Z`.replace(/\s+/g, ' ');

        svgContent += `<path d="${headerPath}" fill="${n.color}" />`;
        
        const escTitle = n.label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const escSub = n.subLabel.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        svgContent += `<text x="8" y="17" font-family="Arial, sans-serif" font-weight="bold" font-size="12" fill="white">${escTitle}</text>`;
        svgContent += `<text x="8" y="45" font-family="Arial, sans-serif" font-size="11" fill="#666">${escSub}</text>`;
        svgContent += `</g>\n`;
    });

    return `
<svg xmlns="http://www.w3.org/2000/svg" width="${maxGraphWidth + PADDING}" height="${maxGraphHeight + PADDING}">
  ${svgContent}
</svg>`.trim();
};

export const getBluePrintHierarchy = {
    name: "getBluePrintHierarchy",
    description: `Retrieves the BluePrint hierarchy for a specified Content Manager item.
The hierarchy shows the parent and child relationships for the item within the BluePrint, which is fundamental for content inheritance and reuse.

### Output Structure
This tool can return either a **JsonGraph** (for data processing) or an **Svg** image (for visualization).

1. **JsonGraph**: Returns a minimal directed graph structure with nodes (Id, Title) and edges.
2. **Svg**: Returns an SVG string that visualizes the hierarchy. Green nodes indicate localized items, while purple nodes indicate shared items.

Example Structure:
{
  "graph": {
    "nodes": [
      { 
        "id": "tcm:0-2-1", 
        "label": "Child Pub", 
        "data": { 
           "item": { 
              type: "Page",
              "Id": "tcm:2-123-64", 
              "Title": "My Page", 
           } 
        } 
      }
    ],
    "edges": [
      { "source": "tcm:0-1-1", "target": "tcm:0-2-1", "relation": "has child" }
    ]
  }
}

### "Find-Then-Fetch" Pattern
When using 'JsonGraph' mode, this tool returns minimal identification data. It does **not** return deep details like 'VersionInfo' or 'BluePrintInfo' properties for every node.
To analyze the hierarchy nodes (e.g., to find which specific user created the item in the Parent Publication):
1.  **Find:** Use this tool to get the hierarchy graph.
2.  **Fetch:** Iterate through the nodes in the graph using the 'toolOrchestrator' and call 'getItem' for the specific IDs you need to inspect.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The TCM URI of the item for which to retrieve the BluePrint hierarchy."),
        outputFormat: z.enum(["JsonGraph", "Svg"]).optional().default("JsonGraph").describe("Specifies the output format. Defaults to 'JsonGraph', which formats the data for efficient graph processing. 'Svg' generates and returns an SVG image of the hierarchy using a high-performance internal layout engine."),
    },
    execute: async ({ itemId, outputFormat = "JsonGraph" }: { itemId: string; outputFormat: "JsonGraph" | "Svg" }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            
            // If output is SVG, we MUST fetch 'BluePrintInfo.IsLocalized' to render the colors correctly.
            // If output is JsonGraph, we stick to the minimal "Find-then-Fetch" pattern (Id & Title only).
            const isSvgMode = outputFormat === 'Svg';
            const apiDetails = isSvgMode ? 'Contentless' : 'IdAndTitleOnly';
            const propsToInclude = isSvgMode ? ['BluePrintInfo.IsLocalized'] : [];

            const escapedItemId = itemId.replace(':', '_');
            const response = await authenticatedAxios.get(`/items/${escapedItemId}/bluePrintHierarchy`, {
                params: { details: apiDetails }
            });

            if (response.status !== 200) {
                return handleUnexpectedResponse(response);
            }

            const rawData = response.data;
            const nodes = new Map<string, any>();
            const edges: { source: string; target: string; relation: string; }[] = [];

            rawData.Items.forEach((bpNode: any) => {
                const pubId = bpNode.ContextRepositoryId;

                const filteredItem = filterResponseData({
                    responseData: bpNode.Item,
                    includeProperties: propsToInclude,
                    details: "IdAndTitle"
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
                const svgOutput = generateSvg(Array.from(nodes.values()), edges);

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
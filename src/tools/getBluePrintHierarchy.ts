import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const getBluePrintHierarchy = {
    name: "getBluePrintHierarchy",
    description: "Retrieves the BluePrint hierarchy for a specified Content Manager item. The hierarchy shows the parent and child relationships for the item within the BluePrint, which is fundamental for content inheritance and reuse.",
    input: {
        itemId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The TCM URI of the item for which to retrieve the BluePrint hierarchy."),
        outputFormat: z.enum(["Raw", "JsonGraph"]).optional().default("Raw").describe("Specifies the output format. 'Raw' returns the direct JSON response from the API. 'JsonGraph' formats the data as a directed acyclic graph, suitable for visualization."),
        details: z.enum(["IdAndTitleOnly", "WithApplicableActions", "Contentless"]).optional().default("WithApplicableActions").describe("Specifies the level of detail for the items returned in the hierarchy. This parameter is ignored when requesting JsonGraph output format."),
    },
    execute: async ({ itemId, outputFormat, details }: { itemId: string; outputFormat: "Raw" | "JsonGraph"; details: "IdAndTitleOnly" | "WithApplicableActions" | "Contentless" }) => {
        try {
            const escapedItemId = itemId.replace(':', '_');
            const apiDetails = outputFormat === 'JsonGraph' ? 'IdAndTitleOnly' : details;
            const response = await authenticatedAxios.get(`/items/${escapedItemId}/bluePrintHierarchy`, {
                params: { details: apiDetails }
            });

            if (response.status !== 200) {
                return {
                    content: [],
                    errors: [{ message: `Failed to retrieve BluePrint hierarchy. Status: ${response.status}, Message: ${response.statusText}` }],
                };
            }

            if (outputFormat === "Raw") {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(response.data, null, 2)
                    }],
                };
            }

            // Transform to JSON Graph Format
            const rawData = response.data;
            const nodes = new Map<string, any>();
            const edges: { source: string; target: string; relation: string; }[] = [];

            // First pass: Create all nodes from the main items list.
            // This ensures we capture the item's context in each Publication.
            rawData.Items.forEach((bpNode: any) => {
                const pubId = bpNode.ContextRepositoryId;
                if (!nodes.has(pubId)) {
                    nodes.set(pubId, {
                        id: pubId,
                        label: bpNode.ContextRepositoryTitle,
                        metadata: {
                            item: {
                                id: bpNode.Item.Id,
                                title: bpNode.Item.Title,
                            }
                        }
                    });
                }
            });

            // Second pass: Create edges and add any parent nodes that might have been missed
            // (e.g., if the hierarchy is deeper than the returned item list).
            rawData.Items.forEach((bpNode: any) => {
                const childPubId = bpNode.ContextRepositoryId;
                if (bpNode.Parents) {
                    bpNode.Parents.forEach((parent: any) => {
                        const parentPubId = parent.IdRef;
                        // If a parent wasn't in the main list, add a basic node for it.
                        if (!nodes.has(parentPubId)) {
                            nodes.set(parentPubId, {
                                id: parentPubId,
                                label: parent.Title
                            });
                        }
                        edges.push({
                            source: childPubId,
                            target: parentPubId,
                            relation: "is child of"
                        });
                    });
                }
            });

            const graph = {
                graph: {
                    directed: true,
                    type: "BluePrintHierarchy",
                    label: `BluePrint Hierarchy for ${itemId}`,
                    nodes: Array.from(nodes.values()),
                    edges
                }
            };

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(graph, null, 2)
                }],
            };

        } catch (error) {
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to retrieve BluePrint hierarchy for item ${itemId}: ${errorMessage}` }],
            };
        }
    }
};
import { z } from "zod";

/**
 * Represents a directed edge in the BluePrint hierarchy.
 */
export const hierarchyEdgeSchema = z.object({
    source: z.string().describe("The ID of the parent publication. For creation, use 'ROOT' to link to the top-level publication."),
    target: z.string().describe("The ID of the child publication (must match a node 'id').")
});

/**
 * Generates a Zod schema for a BluePrint Graph (Nodes and Edges).
 * @param nodeDataSchema The Zod schema representing the 'data' property of a node.
 */
export const createJsonGraphSchema = (nodeDataSchema: z.ZodTypeAny) => z.object({
    nodes: z.array(z.object({
        id: z.string().describe("A unique identifier for this node within the graph."),
        label: z.string().optional().describe("A human-readable label for the node."),
        data: nodeDataSchema.describe("The payload data for this publication.")
    })).describe("The list of publications (nodes) in the hierarchy."),
    edges: z.array(hierarchyEdgeSchema).describe("The relationships (edges) between publications.")
});
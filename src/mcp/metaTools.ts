import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getToolRegistry, getToolsSummary, Tool } from "../utils/toolRegistry.js";

/**
 * The getToolDetails meta-tool allows the LLM to discover the full documentation
 * and Zod-derived JSON schemas for specific tools.
 */
export const getToolDetails = {
    name: "getToolDetails",
    get description() {
        const summary = getToolsSummary();
        return `Dynamically retrieves detailed documentation and input schemas for available tools.

CRITICAL: You should use this tool NOT ONLY to figure out how to execute an action, but ALSO to look up information to answer the user's general questions about CMS capabilities, field configurations, or system rules. 

The list of "AVAILABLE TOOLS" below contains concise "SEO hooks" (summaries) for each tool. Use these hooks to identify which tool possesses the knowledge needed to answer a user's question. If a user asks "how do I do X in the CMS?", use this tool to read the relevant tool's full documentation before attempting to search the web or provide a general answer.

AVAILABLE TOOLS:
${summary}

Note: If a tool's description mentions using another tool, you must access that referenced tool via \`callTool\`.`;
    },
    input: {
        toolNames: z.array(z.string()).describe("An array of exact tool names to retrieve documentation for. You can request multiple tools at once.")
    },
    execute: async ({ toolNames }: { toolNames: string[] }) => {
        const registry = getToolRegistry();
        const results = toolNames.map(name => {
            const tool = registry.get(name);
            if (!tool) {
                return {
                    toolName: name,
                    error: `Tool '${name}' not found in the registry.`
                };
            }

            // Convert Zod schema (tool.input) to JSON schema
            // tool.input is typically a record of zod objects, so we wrap it in z.object()
            const jsonSchema = zodToJsonSchema(z.object(tool.input), {
                name: tool.name,
                target: "jsonSchema7"
            });

            return {
                toolName: tool.name,
                summary: tool.summary,
                description: tool.description,
                inputSchema: jsonSchema
            };
        });

        return {
            content: [{
                type: "text",
                text: JSON.stringify(results, null, 2)
            }]
        };
    }
};

/**
 * The callTool meta-tool is the single execution point for all tools in the registry.
 * It performs runtime validation against the tool's Zod schema before execution.
 */
export const callTool = {
    name: "callTool",
    description: "Executes a specific tool with the provided parameters. Validates the input against the tool's schema before execution.",
    input: {
        toolName: z.string().describe("The name of the tool to execute."),
        parameters: z.record(z.any()).describe("The parameters to pass to the tool, as a JSON object.")
    },
    execute: async ({ toolName, parameters }: { toolName: string, parameters: Record<string, any> }, context: any) => {
        const registry = getToolRegistry();
        const tool = registry.get(toolName);

        if (!tool) {
            return {
                content: [{
                    type: "text",
                    text: `Error: Tool '${toolName}' not found.`
                }]
            };
        }

        try {
            // 1. Validate parameters against tool's Zod schema
            const validatedParams = z.object(tool.input).parse(parameters);

            // 2. Prepare context (preserving special injection for toolOrchestrator)
            let executionContext = context;
            if (toolName === 'toolOrchestrator') {
                // Convert Map to Record for compatibility with existing toolOrchestrator logic
                const toolsAsRecord: Record<string, Tool> = {};
                registry.forEach((t, name) => {
                    toolsAsRecord[name] = t;
                });

                executionContext = {
                    ...context,
                    tools: toolsAsRecord
                };
            }

            // 3. Execute the tool
            return await tool.execute(validatedParams, executionContext);

        } catch (error: any) {
            // Return validation errors or execution errors as text responses so the LLM can see them
            let errorMessage = error.message;

            if (error instanceof z.ZodError) {
                errorMessage = `Validation Error: ${JSON.stringify(error.flatten().fieldErrors, null, 2)}`;
            }

            return {
                content: [{
                    type: "text",
                    text: `Error executing '${toolName}': ${errorMessage}`
                }]
            };
        }
    }
};

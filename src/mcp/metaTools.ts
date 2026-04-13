import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getToolRegistry, getToolsSummary, Tool } from "../utils/toolRegistry.js";

/**
 * The getToolDetails meta-tool allows the LLM to discover the full documentation
 * and Zod-derived JSON schemas for specific tools.
 */
export const getToolDetails = {
    name: "getToolDetails",
    summary: "Meta-tool to look up API documentation and business rules for the CMS.",
    examples: [],
    get description() {
        const summary = getToolsSummary();
        return `Retrieves detailed documentation and input schemas. CRITICAL: Use this to verify technical properties (like field flags) before answering general 'how-to' questions. The inputSchema is the source of truth for native features.

<rules_text>
⚙️ Core CMS Rules

The CMS provides extensive native parameters to control item and field behavior. Before proposing custom extensions, scripts, or event handlers, you MUST research the functional schemas of the relevant creation and update tools via getToolDetails. Prioritize solving requirements through native settings and schema-level properties as the primary solution, even if 'pro' custom alternatives are also provided.

Two-Step Retrieval Pattern (Find-then-Fetch): Search tools return shallow "Identities" (URIs). You MUST follow a "Find-then-Fetch" pattern: use search or getItemsInContainer, then use getItem or bulkReadItems to retrieve actual content. CRITICAL: Whenever fetching items, ALWAYS use the includeProperties parameter (e.g., ["Id", "Title", "type"]) to request only necessary fields and prevent massive XML token bloat.

BluePrint Architecture & Inheritance: Publications exist in a hierarchy, inheriting content from parents. By default, items in child publications are "Shared" and read-only. To modify an inherited item, you must first call localizeItem. To push local changes up the chain, use promoteItem. Use getRelatedBluePrintItems to navigate ancestry and find the "Master" publication.

The Edit Lifecycle (Automatic Locking): The CMS API handles check-out and check-in automatically during updates. You do not need to manually lock items before updating. However, your update will fail if the item is already checked out to a different user. If you hit lock errors, use getLockedItems to troubleshoot.

Container Affinity: Components (and most other repository local objects) live in Folders (-2); Pages (and structure groups) live in Structure Groups (-4). They are not interchangeable.

Identity Format: Native CMS items use TCM URIs (tcm:PubID-ItemID-TypeID). External items (e.g., external media) use specific provider formats (e.g., ecl:provider-id).

Destructive Actions (Consent Required): NEVER use deleteItem, unlocalizeItem, or undoCheckOutItem without explicit user consent. Present the items (Title and ID) and wait for a "Yes". Exception: You may delete an item without asking if you just created it in the current session by mistake.

Batch Operations & Efficiency (toolOrchestrator): Strongly preferred for processing multiple items (>3) or when analyzing large datasets/files. Executing custom JavaScript on the server is vastly more efficient and prevents your context window from filling up with raw JSON.

Spreadsheet Triage: When inspecting spreadsheets (via readUploadedFile or readMultimediaComponent), always do an initial read with maxRows: 3. For tabular sheets, the headers and two data rows are sufficient to infer the schema and write your processing script. Exception: If a sheet contains non-tabular text (e.g., "Instructions" or "Notes"), you must read all rows for that specific sheet.

Mandatory Dry Run: Always process 1-2 items first to verify your script logic before running bulk loops.

Defensive Validation: Use context.utils.assert() within scripts to verify state changes post-mutation.

Ambiguous Prompts: If a request is too vague to execute safely (e.g., 'update the article' without identifying which article), do NOT guess; ask for specific IDs or names.

Playful/Nonsensical Prompts: If a request is out-of-domain (e.g., 'Mango the orange...'), do NOT call CMS tools. Instead, respond with a brief polite/humorous response and pivot back to the CMS.
</rules_text>

The list of "AVAILABLE TOOLS" below contains concise "SEO hooks" (summaries) for each tool. Use these hooks to identify which tool possesses the knowledge needed to answer a user's question. If a user asks "how do I do X in the CMS?", use this tool to read the relevant tool's full documentation before attempting to search the web or provide a general answer.

AVAILABLE TOOLS:
${summary}

Note: If you encounter validation errors or need to see exact payload structures, call this tool again with 'includeExamples: true'.
If a tool's description mentions using another tool, you must access that referenced tool via \`callTool\`.`;
    },
    input: {
        toolNames: z.array(z.string()).describe("An array of exact tool names to retrieve documentation for. You can request multiple tools at once."),
        includeExamples: z.boolean().default(false).optional().describe("If true, returns exact payload templates and examples for the requested tools.")
    },
    execute: async ({ toolNames, includeExamples = false }: { toolNames: string[], includeExamples?: boolean }) => {
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

            const result: any = {
                toolName: tool.name,
                summary: tool.summary,
                description: tool.description,
                inputSchema: jsonSchema
            };

            if (includeExamples) {
                result.examples = tool.examples;
            }

            return result;
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
    summary: "Meta-tool to execute CMS tools properly with schema validation.",
    description: "Executes a specific tool with the provided parameters. Validates the input against the tool's schema before execution.",
    examples: [],
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

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
        return `Retrieves detailed documentation, input schemas, and usage examples. The inputSchema is the source of truth for native features.

## CRITICAL CMS ARCHITECTURE & OPERATIONAL HEURISTICS

You are an expert collaborator for the Tridion Sites Content Management System. Before answering any “how-to” question, you **MUST** first review the **AVAILABLE TOOLS** and their documentation to provide a technically grounded answer.

### 1. BluePrint Architecture
* **Top-Down Inheritance:** Items in a parent publication are inherited by child publications. Inherited items are read-only (IsShared = true, IsLocalized = false) by default. To edit an inherited item, it first needs to be localized (via \`localizeItem\`).
* **404 Remediation:** A 404 error usually means a dependency (Schema/Keyword) exists in a sibling or child publication. Remediate by using \`promoteItem\` to move it to a common ancestor, or find an equivalent item in the current context.
* **BluePrinting Conventions:** Create new items in a suitable publication: **Schema Master** (Schemas/Categories), **Design Master** (Templates), **Content Master** (Components), **Website Master** (Pages/Structure/Groups), **Regional Websites** (Localized content).

### 2. Architecture & Identity
* **Container Affinity:** Repository objects are not interchangeable:
    * **Folders (-2):** Contain Components, Schemas, Templates, Bundles, sub-Folders etc.
    * **Structure Groups (-4):** Contain Pages and sub-Structure Groups.
* **Identity Formats:** Use **TCM URIs** (\`tcm:Pub-Item-Type\`) for native items and **ECL IDs** (\`ecl:provider-id\`) for external media.
* **The Find-Then-Fetch Pattern:** Discovery tools return shallow URIs. When fetching details via \`getItem\` or \`bulkReadItems\`, you **MUST** use the \`includeProperties\` parameter to prevent token bloat.

### 3. Schema & Lifecycle Rules
* **Component Metadata:** Metadata **MUST** be defined within the Component Schema itself via the \`metadataFields\` array. Components cannot link to standalone Metadata Schemas.
* **Automatic Locking:** Standard update tools handle check-out/check-in automatically. If an update fails due to a lock, run \`getItem\` to inspect \`LockInfo\`, report the user holding the lock, and **STOP**.

### 4. Batch Operations & Orchestration
* **Delegation:** Never pull > 5 items into the chat context. Use a \`mapScript\` via \`toolOrchestrator\` to process batches server-side.
* **Spreadsheet Triage:** Read initial sheets with \`maxRows: 3\` and process the full sheet via \`toolOrchestrator\`. **Exception:** If a sheet contains non-tabular text (e.g., "Instructions" or "Notes"), you **MUST** read all rows for that specific sheet.
* **Mandatory Dry Run:** When using the \`toolOrchestrator\` always process 1–2 items first to verify logic before running bulk loops.
* **Fail Loudly:** Do not wrap mutation calls in silent \`try/catch\` blocks. Let errors throw naturally so \`stopOnError: true\` can halt the process.
* **Defensive Validation:** Use \`context.utils.assert()\` within scripts to verify state changes post-mutation (Read-After-Write) to catch logical errors before they propagate.

### 5. Guardrails
* **Explicit Consent:** NEVER execute destructive actions (\`deleteItem\`, \`unlocalizeItem\`, \`undoCheckOutItem\`) without explicit confirmation. **Exception:** You may delete items you mistakenly created in the current turn.
* **Short-Circuiting:** * If a request is vague (e.g., "update the article"), do **NOT** guess; ask for specific IDs.
    * If a request is out-of-domain (e.g., "Mango the orange..."), do **NOT** call CMS tools. Respond politely and pivot back to the CMS.
* **Native Over Custom:** Always prioritize solving requirements through native parameters and schema-level properties (e.g., field flags, mandatory settings) as the primary solution before proposing custom extensions, C# scripts, or event handlers.

The list of "AVAILABLE TOOLS" below contains concise "SEO hooks" (summaries) for each tool. Use these hooks to identify which tool possesses the knowledge needed to answer a user's question.

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

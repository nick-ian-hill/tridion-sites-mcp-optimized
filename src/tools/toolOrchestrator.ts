import { z } from "zod";
import * as vm from 'vm';
import { formatForAgent, formatForApi } from "../utils/fieldReordering.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";

// --- Security Configuration ---
/**
 * Defines the maximum time a script's synchronous code can run.
 * This prevents `while(true)` loops from blocking the thread.
 */
const SYNC_SCRIPT_TIMEOUT_MS = 5000; // 5 seconds

/**
 * Defines the maximum total time an async script can run (including awaiting tools).
 * This prevents runaway scripts or long-running operations.
 */
const TOTAL_SCRIPT_TIMEOUT_MS = 120000; // 120 seconds

/**
 * A strict deny-list of tool names that *cannot* be passed to the sandboxed script.
 */
const DISALLOWED_TOOLS: string[] = [
    "toolOrchestrator",
    "deleteItem",
    "createMultimediaComponentFromPrompt",
    "updateMultimediaComponentFromPrompt",
    "generateContentFromPrompt",
    "readImageDetailsFromMultimediaComponent",
];

/**
 * Creates the base "clean-room" sandbox for running a script.
 * It has no access to Node.js globals (process, require) or Object.prototype.
 */
const createBaseSandbox = (): any => {
    const sandbox = Object.create(null);

    // Add back safe, standard JS globals
    sandbox.Object = Object;
    sandbox.Array = Array;
    sandbox.String = String;
    sandbox.Number = Number;
    sandbox.Boolean = Boolean;
    sandbox.JSON = JSON;
    sandbox.Promise = Promise;
    sandbox.Error = Error;
    sandbox.RegExp = RegExp;
    sandbox.Date = Date;
    sandbox.Math = Math;
    sandbox.Map = Map;
    sandbox.Set = Set;
    sandbox.URL = URL;
    sandbox.URLSearchParams = URLSearchParams;

    // Common Error types
    sandbox.TypeError = TypeError;
    sandbox.SyntaxError = SyntaxError;
    sandbox.RangeError = RangeError;
    sandbox.ReferenceError = ReferenceError;

    return sandbox;
};
// --- End Security Configuration ---

// --- Utilities for Scripts ---
const scriptUtils = {
    /** Converts an item ID to match a specific publication context. Returns the string ID directly. */
    convertItemIdToContextPublication,
    
    /**
     * Throws an error if the condition is false.
     * Useful for validation scripts.
     */
    assert: (condition: boolean, message?: string) => {
        if (!condition) {
            throw new Error(message || "Assertion failed");
        }
    },

    /**
     * Returns a random sample of items from an array.
     * Useful for auditing a subset of results.
     */
    sample: <T>(array: T[], size: number): T[] => {
        if (!Array.isArray(array)) return [];
        if (size <= 0) return [];
        const shuffled = array.slice().sort(() => 0.5 - Math.random());
        return shuffled.slice(0, size);
    }
};

// Define the shape of the context object for the pre-processing script.
interface PreScriptContext {
    /** The JSON object passed to the 'parameters' input of the toolOrchestrator tool. */
    parameters: Record<string, any>;
    /** A dictionary of all available tools, wrapped for execution (e.g., `tools.search`, `tools.getItemsInContainer`). */
    tools: { [toolName: string]: (args: any) => Promise<any> };
    /** A set of synchronous utility functions. */
    utils: typeof scriptUtils;
    /** A function to log messages, which will be included in the final summary. */
    log: (message: string) => void;
}

// Define the shape of the context object for the main 'map' script.
interface MapScriptContext {
    /** The TCM URI of the item currently being processed in the loop. */
    currentItemId: string;
    /** The JSON object passed to the 'parameters' input of the toolOrchestrator tool. */
    parameters: Record<string, any>;
    /** The 'preProcessingResult' object returned by the 'preProcessingScript' (if any). */
    preProcessingResult: any;
    /** A dictionary of all available tools, wrapped for execution (e.g., `tools.getItem`, `tools.updateContent`). */
    tools: { [toolName: string]: (args: any) => Promise<any> };
    /** A set of synchronous utility functions. */
    utils: typeof scriptUtils;
    /** A function to log messages, which will be included in the final summary. */
    log: (message: string) => void;
}

// This plain object defines the input properties, matching your other tools
const toolOrchestratorInputProperties = {
    itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/))
        .optional()
        .describe("An optional array of unique IDs (TCM URIs) to be processed. If provided, these are passed to the 'mapScript'. If a 'preProcessingScript' is also provided, the IDs returned by that script take precedence."),
    preProcessingScript: z.string().optional()
        .describe("Phase 1 (Setup): An optional async function body that runs once before the loop. Must return `string[]` (item IDs) or `{ itemIds: string[], preProcessingResult?: any }`. Use this for dynamic discovery (e.g. `search`) or setup."),
    mapScript: z.string().optional()
        .describe("Phase 2 (Map): An optional async function body that runs for EACH item. Mandatory if 'itemIds' are present. Use `context.currentItemId` to inspect or modify the item. To flag an item as a potential issue without stopping, use `console.warn('Reason')`."),
    postProcessingScript: z.string().optional()
        .describe("Phase 3 (Reduce): An optional async function body that runs once after all items are processed. Has access to `context.results`, `context.successes`, `context.warnings`, and `context.failures`. Returns the final output."),
    validationScript: z.string().optional()
        .describe("Phase 4 (Validation): An async function body that runs LAST. MANDATORY if 'mapScript' is used. It receives `context.output`. You MUST use this to AUDIT the operation (e.g., verify the count of created items matches the input, fetch one of the created items and check if the content fields were populated correctly). Throw an Error if validation fails."),
    parameters: z.record(z.any()).optional()
        .describe("An optional JSON object of parameters to pass into all scripts. Use this for simple, static values like search queries, find/replace strings, or target TCM URIs. Note: Complex objects (like data from other tools) passed as parameters are treated as literal values. If you pass a stringified JSON object as a parameter value, you must manually call JSON.parse() on it inside your script. (Note: this only applies to input parameters, not to the responses from tool calls, which are always auto-parsed)."),
    stopOnError: z.boolean().optional().default(true)
        .describe("If true (default), the entire operation stops if any single item fails during the 'map' phase. If false, it logs the error and continues to the next item."),
    maxConcurrency: z.number().int().min(1).max(10).optional().default(5)
        .describe("The maximum number of 'map' scripts to run in parallel. Set to 1 for sequential execution (e.g., for script validation and debugging, or if the server is under heavy load)."),
    includeScriptResults: z.boolean().optional().default(false)
        .describe("Controls whether the final output includes the individual results from the 'mapScript'. This parameter is ignored if a 'postProcessingScript' is provided. Set to 'true' for 'reporting' tasks where you want a list of all results. Leave 'false' for 'bulk update' tasks where you only care about the final summary."),
    debug: z.boolean().optional().default(false)
        .describe("If true, the full execution log is included in the JSON response. Defaults to false. Only consider setting this to true when debugging.")
};

const toolOrchestratorSchema = z.object(toolOrchestratorInputProperties)
    .refine(data => !data.mapScript || data.validationScript, {
        message: "Safety Guardrail: You provided a 'mapScript' to process items, but you did not provide a 'validationScript'. You MUST provide a validation script to audit the results (e.g., fetch a sample item to verify it was created/updated correctly).",
        path: ["validationScript"]
    });

export const toolOrchestrator = {
    name: "toolOrchestrator",
    description: `Executes an advanced, multi-step JavaScript script to perform batch operations, aggregations, or complex workflows.
    The tool supports up to four phases:
    1.  Setup (preProcessingScript): Dynamically find items (e.g., via 'search') or prepare data.
    2.  Map (mapScript): Process each item individually (e.g., 'updateContent', 'getItem').
    3.  Reduce (postProcessingScript): Aggregate results or generate a summary.
    4.  Validate (validationScript): Audit the final state to ensure success.

    CRITICAL RULE: "Find-Then-Fetch" Pattern
    Discovery tools (like 'search', 'getItemsInContainer', 'getDependencyGraph') ONLY return identification data (Id, Title, type).
    To inspect properties (Metadata, Content, RevisionDate), you MUST:
    1.  Find: Use 'search' in 'preProcessingScript' to get IDs.
    2.  Fetch: Use 'mapScript' to call 'getItem' for specific details.

    CRITICAL RULE: "Verify, Don't Trust"
    Agents often assume a task is complete because no errors were thrown. This leads to hallucinations of success.
    You MUST use the 'validationScript' to inspect a random sample of the processed items.
    
    Validation Utilities:
    - 'context.utils.sample(array, n)': Returns 'n' random items from the array. Use this on 'context.successes'.
    - 'context.utils.assert(condition, message)': Throws an error if the condition is false.

    Handling "Silent Errors" (Warnings):
    Sometimes an operation doesn't fail but yields an unexpected result (e.g., "Item skipped because it was locked").
    In your 'mapScript', use 'console.warn("Reason")' to flag these items. They will appear in 'context.warnings' in the validation phase, allowing you to double-check them.

    CRITICAL SCRIPT DESIGN PRINCIPLES
    1.  Mandatory Error Handling: If a required operation fails (e.g., a lookup returns undefined, an item creation is impossible), your script MUST throw an Error (e.g., 'throw new Error("Missing dependency ID")'). A script that returns without throwing an Error will be marked as 'Success' by the orchestrator, leading to false reporting. Logging a warning is insufficient for critical failures.
    2.  Validation/Audit: For bulk create or update operations (e.g., 'updateContent', 'createPage'), do not blindly rely on the absence of errors to report success. Use the 'validationScript' (Phase 4) to audit one or more updated items (via 'context.tools.getItem') to validate that the changes were persisted as intended.
    3.  Handling Heavy Data (Excel/JSON): Do not read entire Excel files or large JSON blobs directly into the chat context. This consumes the context window and causes "output truncated" errors.
        - First: Use a script to read the Excel file, parse it, and return a summary (e.g., column headers or a row count) to help you understand the structure.
        - Then: Process the data entirely within the 'toolOrchestrator' scripts. Read the file in 'preProcessingScript' and pass the data rows to 'mapScript' via 'context.preProcessingResult'.

    RECOMMENDED STRATEGY FOR COMPLEX TASKS (e.g., Data Import)
    1.  Preferred: The Single-Call Pattern: For stability, execute the entire multi-stage task (Setup, Create Dependencies, Create Consumers) within a single 'toolOrchestrator' call. Use the 'preProcessingScript' to create all prerequisite data maps (e.g., Article ID to Component ID) and pass them in-memory to the 'mapScript' via the 'context.preProcessingResult' object. This method completely avoids token-wasting and error-prone manual serialization/copy-pasting of complex data across multiple 'toolOrchestrator' calls.
    2.  Alternative: The Stateless Multi-Call Pattern (For massive jobs only): If the job is so large that it risks hitting the 120-second execution timeout, you must split it. However, do not manually pass large, complex data maps (like ID lists) as strings in the 'parameters' argument between calls. Instead, design the second script to re-discover the items created by the first script (e.g., "Script 2 uses 'search' to find all components created by Script 1").

    DEBUGGING STRATEGIES
    This is a powerful tool. For any complex script, or if you get an error, follow this debugging process:
    1.  Test on a Single Item: Do not run your script on 500 items at once. First, run it with a single, non-critical item (e.g.,'itemIds': ["tcm:5-100"]).
    2.  Set 'maxConcurrency: 1': This makes the execution log sequential and easy to read.
    3.  Set 'debug: true': This includes a streamlined execution log in the response so you can see what happened.
    4.  Inspect the Result: This single-item test will either succeed, proving your tool calls and parameter logic are valid, or it will fail, giving you a specific, real-world error from the API.
    5.  Use 'context.log()': Calls in your scripts to check variables and data. These will appear in the debug log.
    Only after you have confirmed the single-item test works should you run the script on your full list of 'itemIds'.

    ADVANCED RESILIENCE STRATEGIES
    1.  Resilient Batch (Partial Failures): By default, the tool stops on the first error. For bulk operations where some failures are acceptable, set \`stopOnError: false\`. In \`postProcessingScript\`, inspect \`context.failures\` to report on failed items.
    2.  Safe Execution (Try/Catch): Wrap risky tool calls (like 'getItem') in \`try...catch\` blocks within your \`mapScript\` to handle expected errors (like "Item Not Found") gracefully.

    SCRIPT CONTEXT DETAILS
    The 'preProcessingScript' receives a 'context' object with:
    - context.parameters: The JavaScript object passed to the 'parameters' input.
    - context.tools: A dictionary of all available tools (e.g., context.tools.search).
    - context.utils: Utilities like convertItemIdToContextPublication.
    - context.log(message): A function to log progress.
    Must return \`string[]\` (item IDs) or \`{ itemIds: string[], preProcessingResult?: any }\`.

    The 'mapScript' receives a 'context' object with:
    - context.currentItemId: The ID of the item currently being processed.
    - context.parameters: The JavaScript object passed to the 'parameters' input.
    - context.preProcessingResult: The live JavaScript object returned by the preProcessingScript (if any). No JSON.parse() is needed.
    - context.tools: A dictionary of all available tools.
    - context.utils: Utilities ('assert', 'sample', 'convertItemIdToContextPublication').
    - context.log(message): Logging function. 'console.warn()' marks the item as a Warning.

    The 'postProcessingScript' receives a 'context' object with:
    - context.results: The read-only array of all results from the 'map' phase.
    - context.successes: A pre-filtered array of all successful results.
    - context.warnings: A pre-filtered array of items marked with 'console.warn'.
    - context.failures: A pre-filtered array of all failed results.
    - context.parameters, context.preProcessingResult, context.tools, context.utils, context.log.

    The 'validationScript' (Phase 4) receives a 'context' object with:
    - context.output: The final result returned by the postProcessingScript (or the default summary).
    - context.results, context.successes, context.warnings, context.failures, context.parameters, context.preProcessingResult, context.tools, context.utils, context.log.

    NOTES
    - Automatic JSON parsing: All tools have their JSON string responses automatically parsed into JavaScript objects. You do not need to parse tool responses in a script.
    - Script Limits: All scripts are sandboxed. Sync code max 5s, Async max 120s.
    - Disallowed Tools: 'toolOrchestrator' and 'deleteItem' cannot be called recursively.
    - Data Passing: DO NOT pass large JSON strings via parameters. Use 'preProcessingScript' to fetch data and pass via 'preProcessingResult'.

    ### EXAMPLES

    **Example 1: Batch Search & Update with Sampling Validation (Setup -> Map -> Validate)**
    Finds all Components using a specific Schema and updates a field, then verifies a sample.
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        parameters: { "schemaId": "tcm:5-20-8", "newValue": "Updated Value" },
        preProcessingScript: \`
            context.log('Phase 1: Finding items...');
            const items = await context.tools.search({
                searchQuery: { 
                    ItemTypes: ["Component"], 
                    BasedOnSchemas: [{ schemaUri: context.parameters.schemaId }],
                    SearchIn: "tcm:0-5-1" 
                }
            });
            return items.map(i => i.Id);
        \`,
        mapScript: \`
            // Phase 2: Update each item
            await context.tools.updateContent({
                itemId: context.currentItemId,
                content: { "TextField": context.parameters.newValue }
            });
            context.log("Updated.");
            return { id: context.currentItemId };
        \`,
        validationScript: \`
            if (context.successes.length === 0) return;
            
            // 1. Pick a random sample of 3 successful items
            const sample = context.utils.sample(context.successes, 3);
            context.log(\`Auditing \${sample.length} items...\`);

            for (const item of sample) {
                // 2. Fetch the actual item from CMS
                const freshItem = await context.tools.getItem({ 
                    itemId: item.result.id,
                    includeProperties: ["Content"]
                });
                
                // 3. Assert the value is correct
                const actualValue = freshItem.Content.TextField;
                context.utils.assert(
                    actualValue === context.parameters.newValue, 
                    \`Audit Failed for \${item.result.id}. Expected '\${context.parameters.newValue}', got '\${actualValue}'\`
                );
            }
            context.log("Validation passed: Random sample verification successful.");
        \`
    });
    \`\`\`

    **Example 2: Data Aggregation (Map -> Reduce)**
    Finds the Component with the most versions in a provided list.
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        itemIds: ["tcm:5-100", "tcm:5-101", "tcm:5-102"],
        mapScript: \`
            const history = await context.tools.getItemHistory({ itemId: context.currentItemId });
            return { id: context.currentItemId, count: history.length };
        \`,
        postProcessingScript: \`
            // Find max in context.successes
            if (context.successes.length === 0) throw new Error("No items processed.");
            return context.successes.reduce((max, curr) => 
                (curr.result.count > max.result.count) ? curr : max
            ).result;
        \`
    });
    \`\`\`

    **Example 3: Handling Warnings (Silent Errors)**
    Skips items that are checked out and marks them as warnings, then reports on them.
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        itemIds: ["tcm:5-100", "tcm:5-101"],
        mapScript: \`
            // Check lock status first
            const item = await context.tools.getItem({ itemId: context.currentItemId });
            if (item.LockInfo.LockType !== 'None') {
                console.warn(\`Skipping \${context.currentItemId} because it is locked by \${item.LockInfo.LockUser.Title}\`);
                return null;
            }
            
            // Perform update...
            return { id: context.currentItemId, status: "Updated" };
        \`,
        validationScript: \`
            // The agent can now see which items were skipped
            if (context.warnings.length > 0) {
                context.log(\`Warning: \${context.warnings.length} items were skipped.\`);
            }
        \`
    });
    \`\`\`

    **Example 4: Complex Analysis / Stale Content Report (Find-Then-Fetch)**
    Finds Pages, checks their Publish status, and deep-inspects dependencies to find stale content.
    *Updates:* Uses \`console.warn\` to log why items are skipped, ensuring no "silent" filtering occurs.
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        preProcessingScript: \`
            const items = await context.tools.getItemsInContainer({ 
                containerId: "tcm:0-5-1", itemTypes: ["Page"], recursive: true 
            });
            return items.map(i => i.Id);
        \`,
        mapScript: \`
            // 1. Fetch Page Details (Revision Date)
            const item = await context.tools.getItem({ 
                itemId: context.currentItemId, 
                includeProperties: ["VersionInfo.RevisionDate", "Title"] 
            });

            // 2. Check if Published
            const pubInfo = await context.tools.getPublishInfo({ itemId: context.currentItemId });
            
            // USE WARNINGS: Explicitly log why an item is excluded instead of silently returning null
            if (!pubInfo || pubInfo.length === 0) {
                console.warn(\`Skipped \${context.currentItemId}: Not published\`);
                return null;
            }
            
            // ... (Logic to compare dates: e.g., if RevisionDate > pubInfo.PublishedAt) ...
            
            // If logic determines it is stale:
            return { id: item.Id, title: item.Title, status: "Stale", revisionDate: item.VersionInfo.RevisionDate };
        \`,
        postProcessingScript: \`
            return { 
                stalePages: context.successes.map(s => s.result).filter(r => r !== null),
                skippedCount: context.warnings.length // Report on the skipped items
            };
        \`,
        validationScript: \`
            // Audit: Verify that a reported "Stale" page is actually stale
            if (context.output.stalePages.length > 0) {
                const sample = context.utils.sample(context.output.stalePages, 1);
                const check = await context.tools.getItem({ itemId: sample[0].id });
                context.utils.assert(check.Id === sample[0].id, "Audit Failed: Item ID mismatch");
                context.log(\`Verified existence of reported stale page: \${check.Title}\`);
            }
        \`
    });
    \`\`\`

    **Example 5: Import with Validation (Setup -> Map -> Validate)**
    Imports data and creates items, then audits the result.
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        parameters: { 
            "data": [{ "title": "Page 1", "file": "p1.html" }, { "title": "Page 2", "file": "p2.html" }] 
        },
        preProcessingScript: \`
            return {
                itemIds: context.parameters.data.map(d => d.title),
                preProcessingResult: { sourceData: context.parameters.data }
            };
        \`,
        mapScript: \`
            // Create Page logic here...
            // const newId = await context.tools.createPage(...);
            return { title: context.currentItemId, status: "Created", id: "tcm:5-99-64" };
        \`,
        validationScript: \`
            context.log("Phase 4: Auditing...");
            const results = context.output.results; // Access results from map phase
            if (!results || results.length === 0) return;

            // Audit a sample item
            const sample = results[0];
            const check = await context.tools.getItem({ itemId: sample.result.id });
            if (!check) throw new Error(\`Audit Failed: Created item \${sample.result.id} not found.\`);
            
            context.log("Audit Passed: Item exists.");
        \`
    });
    \`\`\`

    **Example 6: Compliance Report (Staging vs. Live)**
    Finds Pages published to Staging that are NOT published to Live (Review needed).
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        parameters: { "stagingId": "tcm:0-1-65537", "liveId": "tcm:0-2-65537" },
        preProcessingScript: \`
            // Setup: Find all Pages in Publication
            const pages = await context.tools.getItemsInContainer({
               containerId: "tcm:0-5-1", itemTypes: ["Page"], recursive: true
            });
            return pages.map(p => p.Id);
        \`,
        mapScript: \`
            // Map: Check Publish Status for each page
            const info = await context.tools.getPublishInfo({ itemId: context.currentItemId });
            
            const onStaging = info.some(i => i.TargetType.IdRef === context.parameters.stagingId);
            const onLive = info.some(i => i.TargetType.IdRef === context.parameters.liveId);

            if (onStaging && !onLive) return { id: context.currentItemId, status: "Needs Live Publish" };
            return null;
        \`,
        postProcessingScript: \`
            // Reduce: Filter nulls and report
            return { itemsToReview: context.successes.map(s => s.result).filter(r => r !== null) };
        \`
    });
    \`\`\`

    **Example 7: Cleanup - Find Unused Assets**
    Finds images that are not used by any other item.
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        preProcessingScript: \`
            const items = await context.tools.getItemsInContainer({
               containerId: "tcm:0-5-1", itemTypes: ["Component"], recursive: true
            });
            return items.map(i => i.Id);
        \`,
        mapScript: \`
            // Map: Check "UsedBy" dependencies
            // 1. Filter for Multimedia (MimeType check via getItem)...
            // 2. Check usages:
            const usages = await context.tools.getDependencyGraph({
               itemId: context.currentItemId, direction: "UsedBy"
            });
            if (usages.length === 0) return { id: context.currentItemId, status: "Unused" };
            return null;
        \`
    });
    \`\`\`
`,

    input: toolOrchestratorInputProperties,

    execute: async (
        // Type inference for 'input' now uses the internal schema
        input: z.infer<typeof toolOrchestratorSchema>,
        mcpContext: any
    ) => {
        formatForApi(input);
        const {
            itemIds: initialItemIds,
            preProcessingScript,
            mapScript,
            postProcessingScript,
            validationScript,
            parameters = {},
            stopOnError,
            maxConcurrency,
            includeScriptResults,
            debug
        } = input;

        /**
         * Helper function to extract a clear error message from various error types.
         */
        const extractErrorMessage = (e: any): string => {
            try {
                if (!e) return 'Unknown error';
                if (e.message) return e.message;
                if (typeof e === 'string') return e;
                // Standard tool error
                if (e.content && Array.isArray(e.content) && e.content[0]?.type === 'text') {
                    try {
                        const errorObj = JSON.parse(e.content[0].text);
                        const formattedError = formatForAgent(errorObj);
                        if (formattedError && formattedError.Message) {
                            return JSON.stringify(formattedError);
                        }
                    } catch {
                        return e.content[0].text;
                    }
                    return e.content[0].text;
                }
                // Axios-like error
                if (e.data && e.data.content && Array.isArray(e.data.content) && e.data.content[0]?.type === 'text') return e.data.content[0].text;
                return JSON.stringify(e);
            } catch {
                return String(e); // Fallback for circular structures or un-stringifiable errors
            }
        }

        if (!mcpContext.tools || typeof mcpContext.tools !== 'object') {
            return {
                content: [{ type: "text", text: "Error: Tool execution context is missing. 'toolOrchestrator' cannot access other tools." }]
            };
        }

        const results: any[] = [];
        const logs: string[] = [];
        const log = (message: string) => logs.push(message);

        // --- Create Tool Wrappers ---
        const toolWrappers: { [toolName: string]: (args: any) => Promise<any> } = {};
        for (const toolName in mcpContext.tools) {
            // Add a wrapper that throws a clear error for disallowed tools.
            if (DISALLOWED_TOOLS.includes(toolName)) {
                toolWrappers[toolName] = async (_args: any) => {
                    throw new Error(`ToolError: The tool "${toolName}" is not permitted to be called from within the toolOrchestrator for security reasons.`);
                };
                continue;
            }

            if (mcpContext.tools[toolName] && mcpContext.tools[toolName].execute) {
                const originalTool = mcpContext.tools[toolName];
                const originalToolExecute = originalTool.execute;
                const toolInputProperties = originalTool.input;

                toolWrappers[toolName] = async (args: any) => {

                    let validatedArgs = args || {};

                    // Check if the tool has a non-null input object
                    if (toolInputProperties && typeof toolInputProperties === 'object') {

                        // Dynamically create a Zod schema from the tool's input properties
                        const toolInputSchema = z.object(toolInputProperties);

                        // Now, run safeParse on the schema we just built
                        const validationResult = toolInputSchema.safeParse(validatedArgs);

                        if (!validationResult.success) {
                            // Throw a clear Zod error that the script can catch
                            throw new Error(`Invalid arguments for tool '${toolName}': ${validationResult.error.message}`);
                        }
                        // Use the validated (and possibly transformed) args
                        validatedArgs = validationResult.data;
                    }

                    // Pass the validated args to the execute function
                    const result = await originalToolExecute(validatedArgs, mcpContext);

                    // Robust JSON parsing with trim() and try/catch
                    if (result && result.content && Array.isArray(result.content) &&
                        result.content[0] && result.content[0].type === 'text' &&
                        typeof result.content[0].text === 'string') {
                        const maybeText = result.content[0].text.trim();
                        if (maybeText.startsWith('{') || maybeText.startsWith('[')) {
                            try {
                                const parsedObject = JSON.parse(maybeText);
                                // Check if the successfully parsed object is actually an error.
                                if (parsedObject && parsedObject.type === 'Error' && parsedObject.Message) {
                                    throw new Error(parsedObject.Message);
                                }

                                return parsedObject; // Return the successful object

                            } catch (err) {
                                throw err;
                            }
                        }
                    }

                    // Fallback: if tool already returned a plain object (not a standard content wrapper), return it.
                    if (result && typeof result === 'object' && !Array.isArray(result) && !result.content) {
                        return result;
                    }

                    // Default: return the raw result
                    return result;
                };
            }
        }

        // --- Create a secure base sandbox ---
        const baseSandbox = createBaseSandbox();

        let finalItemIds: string[] = initialItemIds || [];
        let hasFailed = false;
        let preScriptContextData: any = {}; // <-- For data from pre-script

        // --- Phase 1: Pre-Processing Logic (Setup Phase) ---
        if (preProcessingScript) {
            logs.push("Starting pre-processing script (setup phase)...");

            let compiledPreScript: vm.Script;
            try {
                compiledPreScript = new vm.Script(`
                    (async () => {
                        "use strict";
                        ${preProcessingScript}
                    })();
                `, { filename: 'preProcessingScript.js' });
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `Pre-processing Script Compilation Error: ${extractErrorMessage(error)}` }]
                };
            }

            const preScriptLog = (message: string) => logs.push(`[PreScript] ${message}`);
            const preScriptErrorLog = (message: string) => logs.push(`[PreScript] [ERROR] ${message}`);
            const preScriptWarnLog = (message: string) => logs.push(`[PreScript] [WARN] ${message}`);
            const preScriptContext: PreScriptContext = {
                parameters: Object.freeze(parameters), // Freeze parameters for security
                tools: toolWrappers,
                utils: scriptUtils,
                log: preScriptLog
            };

            // Create a dedicated sandbox for this script
            const sandboxContext = { ...baseSandbox };
            sandboxContext.context = preScriptContext;
            sandboxContext.console = { log: preScriptLog, error: preScriptErrorLog, warn: preScriptWarnLog };
            const sandbox = vm.createContext(sandboxContext, {
                codeGeneration: { strings: false, wasm: false }
            });

            try {
                const scriptPromise = compiledPreScript.runInContext(sandbox, {
                    timeout: SYNC_SCRIPT_TIMEOUT_MS
                });

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Script timed out after ${TOTAL_SCRIPT_TIMEOUT_MS}ms`)), TOTAL_SCRIPT_TIMEOUT_MS)
                );

                const preScriptResult = await Promise.race([scriptPromise, timeoutPromise]);

                if (Array.isArray(preScriptResult) && preScriptResult.every(item => typeof item === 'string')) {
                    finalItemIds = preScriptResult;
                } else if (typeof preScriptResult === 'object' && preScriptResult !== null && Array.isArray(preScriptResult.itemIds)) {
                    finalItemIds = preScriptResult.itemIds;
                    if (preScriptResult.preProcessingResult) {
                        preScriptContextData = Object.freeze(preScriptResult.preProcessingResult);
                    }
                } else {
                    if (preScriptResult && typeof preScriptResult === 'object') {
                          if (preScriptResult.preProcessingResult) {
                            preScriptContextData = Object.freeze(preScriptResult.preProcessingResult);
                        }
                    }
                }

                logs.push(`Pre-processing script finished. Found ${finalItemIds.length} items to process.`);

            } catch (error: any) {
                const errorMessage = extractErrorMessage(error);
                logs.push(`Pre-processing Script FAILED: ${errorMessage}`);
                const finalErrorSummary = {
                    summary: "ToolOrchestrator FAILED",
                    phase: "pre-processing",
                    error: `Pre-processing Script FAILED: ${errorMessage}`,
                    executionLog: debug ? logs.join('\n') : undefined
                };

                const formattedFinalErrorSummary = formatForAgent(finalErrorSummary);
                return {
                    content: [{ type: "text", text: JSON.stringify(formattedFinalErrorSummary, null, 2) }],
                };
            }
        }

        // --- Phase 2: Execution Logic (Map Phase) ---
        // Only run if we have items AND a map script.
        if (finalItemIds.length > 0) {
            
            if (!mapScript) {
                // GUARDRAIL: Throw error if items are present but no map script is provided.
                // This prevents silent failure where the agent assumes work was done.
                const errorMsg = `Configuration Error: The pre-processing phase found ${finalItemIds.length} items, but no 'mapScript' was provided to process them.
                You must provide a 'mapScript' to inspect or modify these items.
                If you intended to skip the map phase, ensure your pre-processing script returns an empty 'itemIds' array.`;
                logs.push(errorMsg);
                return {
                    content: [{ type: "text", text: JSON.stringify({
                        type: "Error",
                        Message: errorMsg,
                        Hint: "Check the tool description: mapScript is mandatory when iterating over items."
                    }, null, 2)}]
                };
            }

            log(`\nStarting map phase for ${finalItemIds.length} items with maxConcurrency: ${maxConcurrency}`);

            // --- Create ONE reusable sandbox for the entire Map phase ---
            let compiledMapScript: vm.Script;
            try {
                compiledMapScript = new vm.Script(`
                    (async () => {
                        "use strict";
                        ${mapScript}
                    })();
                `, { filename: 'mapScript.js' });
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `Map Script Compilation Error: ${extractErrorMessage(error)}` }]
                };
            }

            /**
             * A single, reusable function to run the script for one item
             * and handle logging, results, and errors.
             */
            const runTask = async (itemId: string, index: number): Promise<void> => {
                logs.push(`\n[${index + 1}/${finalItemIds.length}] Processing item: ${itemId}`);

                // Warning State Tracking
                let itemHasWarning = false;
                let itemWarningMessage = "";

                const perItemLog = (message: string) => logs.push(`[${itemId}] ${message}`);
                const perItemErrorLog = (message: string) => logs.push(`[${itemId}] [ERROR] ${message}`);
                const perItemWarnLog = (message: string) => {
                    logs.push(`[${itemId}] [WARN] ${message}`);
                    itemHasWarning = true;
                    itemWarningMessage = message;
                };

                const perItemContext: MapScriptContext = {
                    currentItemId: itemId,
                    parameters: Object.freeze(parameters),
                    preProcessingResult: preScriptContextData,
                    tools: toolWrappers,
                    utils: scriptUtils,
                    log: perItemLog
                };

                const sandboxContext = { ...baseSandbox };
                sandboxContext.context = perItemContext;
                sandboxContext.console = {
                    log: perItemLog,
                    error: perItemErrorLog,
                    warn: perItemWarnLog
                };

                const sandbox = vm.createContext(sandboxContext, {
                    codeGeneration: { strings: false, wasm: false }
                });

                try {
                    const scriptPromise = compiledMapScript.runInContext(sandbox, {
                        timeout: SYNC_SCRIPT_TIMEOUT_MS
                    });

                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Script timed out after ${TOTAL_SCRIPT_TIMEOUT_MS}ms`)), TOTAL_SCRIPT_TIMEOUT_MS)
                    );

                    const result = await Promise.race([scriptPromise, timeoutPromise]);
                    
                    // Categorize based on warning state
                    if (itemHasWarning) {
                        results.push({
                            itemId: itemId,
                            status: "warning",
                            result: (result === undefined) ? "No return value" : result,
                            warning: itemWarningMessage
                        });
                        logs.push(`[${itemId}] Completed with Warning.`);
                    } else {
                        results.push({
                            itemId: itemId,
                            status: "success",
                            result: (result === undefined) ? "No return value" : result
                        });
                        logs.push(`[${itemId}] Success.`);
                    }

                } catch (error: any) {
                    // Use the new helper function for clean, consistent error messages
                    const errorMessage = extractErrorMessage(error);
                    logs.push(`[${itemId}] FAILED: ${errorMessage}`);
                    results.push({ itemId: itemId, status: "error", error: errorMessage });
                    hasFailed = true;
                }
            };

            // --- Run tasks (sequentially or in parallel) ---
            if (maxConcurrency === 1) {
                log("Running in sequential mode.");
                for (const [index, itemId] of finalItemIds.entries()) {
                    if (stopOnError && hasFailed) {
                        logs.push("\nOperation stopped due to error.");
                        break;
                    }
                    await runTask(itemId, index);
                }
            } else {
                log(`Running in parallel mode with ${maxConcurrency} workers.`);
                const workerPool = new Set<Promise<void>>();
                let index = 0;

                for (const itemId of finalItemIds) {
                    if (stopOnError && hasFailed) {
                        logs.push("\nOperation stopping due to error. No new tasks will be started.");
                        break;
                    }

                    while (workerPool.size >= maxConcurrency) {
                        await Promise.race(workerPool);
                    }

                    const taskPromise = runTask(itemId, index++);

                    const onFinally = () => {
                        workerPool.delete(taskPromise);
                    };

                    taskPromise.then(onFinally, onFinally);
                    workerPool.add(taskPromise);
                }

                await Promise.allSettled(Array.from(workerPool));
            }
            logs.push("\nMap phase finished.");
        } else {
            // Logic: itemIds is empty.
            if (mapScript) {
                 log("No items found to process. Skipping map phase.");
            } else {
                 // This is the valid "Setup Only" path
                 log("No items found and no mapScript provided. Skipping map phase (valid setup-only execution).");
            }
        }
        // --- End of Map Phase ---

        // Prepare the summary or post-script input
        const successes = results.filter(r => r.status === 'success');
        const warnings = results.filter(r => r.status === 'warning');
        const failures = results.filter(r => r.status === 'error');
        
        const successCount = successes.length;
        const warningCount = warnings.length;
        const errorCount = failures.length;

        // --- Phase 3: Post-Processing Logic (Reduce Phase) ---
        let responsePayload: any = null;

        if (postProcessingScript) {
            logs.push("\nStarting post-processing script (reduce phase)...");

            let compiledPostScript: vm.Script;
            try {
                compiledPostScript = new vm.Script(`
                    (async () => {
                        "use strict";
                        ${postProcessingScript}
                    })();
                `, { filename: 'postProcessingScript.js' });
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `Post-processing Script Compilation Error: ${extractErrorMessage(error)}` }]
                };
            }

            const postScriptLog = (message: string) => logs.push(`[PostScript] ${message}`);
            const postScriptErrorLog = (message: string) => logs.push(`[PostScript] [ERROR] ${message}`);
            const postScriptWarnLog = (message: string) => logs.push(`[PostScript] [WARN] ${message}`);

            const sandboxContext = { ...baseSandbox };
            sandboxContext.context = {
                results: Object.freeze(results),
                successes: Object.freeze(successes),
                warnings: Object.freeze(warnings), // New
                failures: Object.freeze(failures),
                parameters: Object.freeze(parameters),
                preProcessingResult: preScriptContextData,
                tools: toolWrappers,
                utils: scriptUtils,
                log: postScriptLog
            };
            sandboxContext.console = { log: postScriptLog, error: postScriptErrorLog, warn: postScriptWarnLog };
            const sandbox = vm.createContext(sandboxContext, {
                codeGeneration: { strings: false, wasm: false }
            });

            try {
                const scriptPromise = compiledPostScript.runInContext(sandbox, {
                    timeout: SYNC_SCRIPT_TIMEOUT_MS
                });

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Script timed out after ${TOTAL_SCRIPT_TIMEOUT_MS}ms`)), TOTAL_SCRIPT_TIMEOUT_MS)
                );

                const finalResult = await Promise.race([scriptPromise, timeoutPromise]);
                logs.push("Post-processing script finished successfully.");

                responsePayload = finalResult;

            } catch (error: any) {
                const errorMessage = extractErrorMessage(error);
                logs.push(`Post-Processing Script FAILED: ${errorMessage}`);

                // Create a small, safe JSON error object.
                const finalErrorSummary = {
                    summary: "ToolOrchestrator FAILED",
                    phase: "post-processing",
                    mapPhaseSummary: {
                        totalItemsProcessed: results.length,
                        succeeded: successCount,
                        warnings: warningCount,
                        failed: errorCount
                    },
                    error: `Post-Processing Script FAILED: ${errorMessage}`,
                    // Add a *small, truncated* piece of the log for context.
                    logSample: logs.slice(-10).join('\n')
                };

                const formattedFinalErrorSummary = formatForAgent(finalErrorSummary);
                return {
                    content: [{ type: "text", text: JSON.stringify(formattedFinalErrorSummary, null, 2) }],
                };
            }
        } else {
            // --- Final Summary (if no post-processing) ---
            responsePayload = {
                summary: "ToolOrchestrator Summary",
                totalItemsProcessed: finalItemIds.length,
                succeeded: successCount,
                warnings: warningCount,
                failed: errorCount
            };

            if (errorCount > 0) {
                responsePayload.errors = failures.map(r => ({ itemId: r.itemId, error: r.error }));
            }
            
            if (warningCount > 0) {
                responsePayload.warnings = warnings.map(r => ({ itemId: r.itemId, warning: r.warning, result: r.result }));
            }

            if (includeScriptResults) {
                responsePayload.results = results
                    .filter(r => r.status === 'success')
                    .map(r => ({ itemId: r.itemId, result: r.result }));
            }
        }

        // --- Phase 4: Validation Logic (Audit Phase) ---
        if (validationScript) {
            logs.push("\nStarting validation script (audit phase)...");

            let compiledValidationScript: vm.Script;
            try {
                compiledValidationScript = new vm.Script(`
                    (async () => {
                        "use strict";
                        ${validationScript}
                    })();
                `, { filename: 'validationScript.js' });
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `Validation Script Compilation Error: ${extractErrorMessage(error)}` }]
                };
            }

            const valScriptLog = (message: string) => logs.push(`[Validation] ${message}`);
            const valScriptErrorLog = (message: string) => logs.push(`[Validation] [ERROR] ${message}`);
            const valScriptWarnLog = (message: string) => logs.push(`[Validation] [WARN] ${message}`);

            const sandboxContext = { ...baseSandbox };
            sandboxContext.context = {
                output: Object.freeze(responsePayload), // The result from Phase 3 (or the summary)
                results: Object.freeze(results),
                successes: Object.freeze(successes),
                warnings: Object.freeze(warnings), // New
                failures: Object.freeze(failures),
                parameters: Object.freeze(parameters),
                preProcessingResult: preScriptContextData,
                tools: toolWrappers,
                utils: scriptUtils,
                log: valScriptLog
            };
            sandboxContext.console = { log: valScriptLog, error: valScriptErrorLog, warn: valScriptWarnLog };
            const sandbox = vm.createContext(sandboxContext, {
                codeGeneration: { strings: false, wasm: false }
            });

            try {
                const scriptPromise = compiledValidationScript.runInContext(sandbox, {
                    timeout: SYNC_SCRIPT_TIMEOUT_MS
                });

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Script timed out after ${TOTAL_SCRIPT_TIMEOUT_MS}ms`)), TOTAL_SCRIPT_TIMEOUT_MS)
                );

                const validationResult = await Promise.race([scriptPromise, timeoutPromise]);
                logs.push("Validation script finished successfully.");

                // If the validation script returns a value, use it to augment or replace the output
                if (validationResult !== undefined) {
                    responsePayload = validationResult;
                }

            } catch (error: any) {
                const errorMessage = extractErrorMessage(error);
                logs.push(`Validation Script FAILED: ${errorMessage}`);

                // Return a specific Validation Failure response
                const validationErrorSummary = {
                    summary: "ToolOrchestrator FAILED",
                    phase: "validation",
                    originalOutput: responsePayload, // Include the work that was done
                    error: `Validation Failed: ${errorMessage}`,
                    logSample: logs.slice(-10).join('\n')
                };

                const formattedError = formatForAgent(validationErrorSummary);
                return {
                    content: [{ type: "text", text: JSON.stringify(formattedError, null, 2) }],
                };
            }
        }

        // --- Final Output Construction ---
        let finalOutput: any = responsePayload;

        if (debug) {
            // Truncate the log to the first 25 and last 25 lines
            let logOutput = logs;
            if (logs.length > 50) {
                logOutput = [
                    ...logs.slice(0, 25),
                    `\n... (log truncated - ${logs.length - 50} lines hidden) ...\n`,
                    ...logs.slice(-25)
                ];
            }
            
            // Wrap the result to include debug info
            finalOutput = {
                result: responsePayload,
                executionLog: logOutput.join('\n')
            };
        }

        return {
            content: [{
                type: "text",
                text: JSON.stringify(finalOutput, null, 2)
            }],
        };
    }
};
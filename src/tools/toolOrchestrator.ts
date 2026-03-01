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
const TOTAL_SCRIPT_TIMEOUT_MS = 600000; // 10 minutes

/**
 * A strict deny-list of tool names that *cannot* be passed to the sandboxed script.
 */
const DISALLOWED_TOOLS: string[] = [
    "toolOrchestrator",
    "deleteItem",
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
    /** Converts an item ID to match a specific publication context.
        Returns the string ID directly. */
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

// --- Interfaces ---

// Define the shape of the context object for the pre-processing script.
interface PreScriptContext {
    /** The JSON object passed to the 'parameters' input of the toolOrchestrator tool. */
    parameters: Record<string, any>;
    /** A dictionary of all available tools, wrapped for execution. */
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
    /** A dictionary of all available tools, wrapped for execution. */
    tools: { [toolName: string]: (args: any) => Promise<any> };
    /** A set of synchronous utility functions. */
    utils: typeof scriptUtils;
    /** A function to log messages, which will be included in the final summary. */
    log: (message: string) => void;
}

/**
 * The structured result returned by the orchestrator.
 * This structure ensures the agent always knows the state of the operation,
 * even if it stopped midway.
 */
interface OrchestratorResult {
    status: "Completed" | "StoppedOnError" | "PartialSuccess";
    summary: string;
    /** List of items that were successfully processed before any stop/completion. */
    processedItems: Array<{ id: string, result: any }>;
    /** The specific item that caused the stop (if stopOnError was true). */
    failedItem?: { id: string, error: string };
    /** The final output data (from postProcessingScript or default summary). */
    output?: any;
    /** The optional execution log, included if debug is true. */
    executionLog?: string;
}

// This plain object defines the input properties, matching your other tools
const toolOrchestratorInputProperties = {
    itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?(-v\d+)?|ecl:[^:\s]+(-v\d+)?)$/))
        .optional()
        .describe("An optional array of unique IDs (TCM URIs) to be processed. If provided, these are passed to the 'mapScript'. If a 'preProcessingScript' is also provided, the IDs returned by that script take precedence."),
    preProcessingScript: z.string().optional()
        .describe("Phase 1 (Setup): An optional async function body that runs once before the loop. Must return `string[]` (item IDs) or `{ itemIds: string[], preProcessingResult?: any }`. Use this for dynamic discovery (e.g. `search`) or setup."),
    mapScript: z.string().optional()
        .describe("Phase 2 (Map): An optional async function body that runs for EACH item. Mandatory if 'itemIds' are present. CRITICAL: If a required lookup fails or an update is impossible, you MUST `throw new Error('Reason')`. If you simply return `null` or `{}` it will be counted as a SUCCESS, leading to false reporting."),
    postProcessingScript: z.string().optional()
        .describe("Phase 3 (Reduce): An optional async function body that runs once after all items are processed. Has access to `context.results`, `context.successes`, `context.warnings`, and `context.failures`. Returns the final output."),
    validationScript: z.string().optional()
        .describe("Phase 4 (Validation): An async function body that runs LAST. MANDATORY if 'mapScript' is used. You MUST use this to AUDIT the operation by using `tools.getItem` on a sample of the results. Do NOT rely solely on `context.hasSuccesses`. Verify that the items actually contain the data you intended to add (e.g., check `ComponentPresentations.length > 0`)."),
    parameters: z.record(z.any()).optional()
        .describe("An optional JSON object of parameters to pass into all scripts. Use this for simple, static values like search queries, find/replace strings, or target TCM URIs."),
    forceSkipIfPresent: z.boolean().optional().default(false)
        .describe("If true, any '409 Conflict' (Item Already Exists) error during creation is treated as an immediate Success without checking if the item properties match."),
    stopOnError: z.boolean().optional().default(true)
        .describe("If true (default), the entire operation stops if any single item fails during the 'map' phase. If false, it logs the error and continues to the next item."),
    maxConcurrency: z.number().int().min(1).max(10).optional().default(5)
        .describe("The maximum number of 'map' scripts to run in parallel. Set to 1 for sequential execution."),
    includeScriptResults: z.boolean().optional().default(false)
        .describe("Controls whether the final output includes the individual results from the 'mapScript'. Defaults to false to save tokens."),
    debug: z.boolean().optional().default(false)
        .describe("If true, the full execution log is included in the JSON response.")
};

const toolOrchestratorSchema = z.object(toolOrchestratorInputProperties)
    .refine(data => !data.mapScript || data.validationScript, {
        message: "Safety Guardrail: You provided a 'mapScript' to process items, but you did not provide a 'validationScript'. You MUST provide a validation script to audit the results.",
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

    --- PARTIAL SUCCESS & ERROR HANDLING ---
    This tool implements specific logic for handling failures:
    - StopOnError = true (Default): The tool stops immediately upon the first error. It returns a "StoppedOnError" status, a list of all items successfully processed *before* the crash, and the specific error details. You should use this data to fix the issue and RESUME operation from the next item.
    - StopOnError = false: The tool attempts to process all items. Failures are recorded in the final "PartialSuccess" report.

    --- CRITICAL RULES FOR SUCCESS ---
    
    1. The Definition of Success vs. Failure
    The orchestrator marks an item as "Success" if the 'mapScript' runs without throwing an Error.
    - If your script returns \`null\`, \`false\`, or \`{ status: "Skipped" }\`, this counts as SUCCESS in the final summary.
    - TO FLAG A FAILURE: You MUST \`throw new Error("Reason")\`.
    - TO FLAG A WARNING: Use \`console.warn("Reason")\`. This will add the item to the 'warnings' count.

    2. "Verify, Don't Trust" (Strong Validation)
    Do not assume the operation worked just because "succeeded" count is > 0.
    In your 'validationScript', you MUST perform a "Read-After-Write" check:
    - Get a sample: \`const sample = context.utils.sample(context.successes, 1)\`.
    - Fetch the FRESH item: \`const item = await context.tools.getItem({ itemId: sample[0].result.id, ... })\`.
    - Assert the state: \`context.utils.assert(item.Content.someField === "expected", "Update failed")\`.
    
    3. "Find-Then-Fetch" Pattern
    Discovery tools (like 'search', 'getItemsInContainer') ONLY return identification data (Id, Title, type).
    To inspect properties (Metadata, Content), you MUST:
    - Find: Use 'search' in 'preProcessingScript' to get IDs.
    - Fetch: Use 'mapScript' to call 'getItem' for specific details.

    4. Idempotency (Creation Tools)
    If you use creation tools (createItem, createPage, etc.) and the item already exists:
    - DEFAULT: The tool will FAIL with a "409 Conflict" error.
    - OPTIONAL: Set 'forceSkipIfPresent: true' in the parameters. The tool will NOT fail; instead, it will skip the item and mark it as "Success (Skipped)".
    - Note: This skip is "blind". It does not check if the existing item matches your input.

    --- SCRIPT CONTEXT DETAILS ---

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
    - context.hasSuccesses: Boolean flag (true if successes.length > 0).
    - context.hasFailures: Boolean flag (true if failures.length > 0).
    - context.hasWarnings: Boolean flag (true if warnings.length > 0).
    - context.results, context.successes, context.warnings, context.failures, context.parameters, context.preProcessingResult, context.tools, context.utils, context.log.

    --- STRATEGIES ---

    DEBUGGING STRATEGIES
    For any complex script, or if you get an error, follow this debugging process:
    1. Test on a Single Item: Do not run your script on 500 items at once. First, run it with a single, non-critical item (e.g.,'itemIds': ["tcm:5-100"]).
    2. Set 'maxConcurrency: 1': This makes the execution log sequential and easy to read.
    3. Set 'debug: true': This includes a streamlined execution log in the response.
    4. Set 'includeScriptResults: true': This reveals what your mapScript is actually returning (e.g., checking if it returns null or status: "skipped").
    5. Inspect the Result: This single-item test will either succeed, proving your logic, or it will fail with a real error.
    
    ADVANCED RESILIENCE STRATEGIES
    1. Resilient Batch (Partial Failures): By default, the tool stops on the first error. For bulk operations where some failures are acceptable, set \`stopOnError: false\`. In \`postProcessingScript\`, inspect \`context.failures\` to report on failed items.
    2. Safe Execution (Try/Catch): Wrap risky tool calls (like 'getItem') in \`try...catch\` blocks within your \`mapScript\` to handle expected errors (like "Item Not Found") gracefully.
   
    Handling Heavy Data: Do not read entire Excel files or large JSON blobs directly into the chat context. First, use a script to read the file and return a summary (e.g., column headers). Then, process the data entirely within the toolOrchestrator scripts by reading the file in 'preProcessingScript' and passing rows to 'mapScript'.
    Complex Tasks: Prefer the Single-Call Pattern. Execute Setup, Map, and Reduce in a single toolOrchestrator call. Pass data from 'preProcessingScript' to 'mapScript' via memory (context.preProcessingResult) rather than outputting large lists of IDs to the chat and pasting them into a second tool call.

    NOTES
    - Automatic JSON parsing: All tools have their JSON string responses automatically parsed into JavaScript objects. You do not need to parse tool responses in a script.
    - Script Limits: All scripts are sandboxed. Sync code max 5s, Async max 600s.
    - Disallowed Tools: 'toolOrchestrator' and 'deleteItem' cannot be called recursively.

    ### EXAMPLES

    **Example 1: Batch Search & Update with Strong Validation**
    Finds Components and updates a field. NOTICE: Validation script fetches the item to verify the update persisted.
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
            if (!context.hasSuccesses) return;
            
            // 1. Pick a random sample of successful items
            const sample = context.utils.sample(context.successes, 3);
            context.log(\`Auditing \${sample.length} items...\`);

            for (const item of sample) {
                // 2. Fetch the actual item from CMS to verify persistence
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

    **Example 2: Data Aggregation**
    Finds the Component with the most versions. Validation ensures data was returned.
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
        \`,
        validationScript: \`
            // Simple validation to ensure we got a result
            context.utils.assert(context.output && context.output.count !== undefined, "Failed to aggregate history");
        \`
    });
    \`\`\`

    **Example 3: Handling Warnings (Silent Errors)**
    Skips items that are checked out and marks them as warnings.
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        itemIds: ["tcm:5-100", "tcm:5-101"],
        mapScript: \`
            // Check lock status first
            const item = await context.tools.getItem({ itemId: context.currentItemId });
            if (item.LockInfo.LockType !== 'None') {
                // Use warning to flag this without failing the script
                console.warn(\`Skipping \${context.currentItemId} because it is locked by \${item.LockInfo.LockUser.Title}\`);
                return null;
            }
            
            // Perform update...
            return { id: context.currentItemId, status: "Updated" };
        \`,
        validationScript: \`
            // The agent can now see which items were skipped
            if (context.hasWarnings) {
                context.log(\`Warning: \${context.warnings.length} items were skipped.\`);
            }
            context.utils.assert(context.hasSuccesses || context.hasWarnings, "No items processed");
        \`
    });
    \`\`\`

    **Example 4: Complex Analysis / Stale Content Report**
    Finds Pages, checks Publish status, and deep-inspects.
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        preProcessingScript: \`
            const items = await context.tools.getItemsInContainer({ 
                containerId: "tcm:0-5-1", itemTypes: ["Page"], recursive: true 
            });
            return items.map(i => i.Id);
        \`,
        mapScript: \`
            const item = await context.tools.getItem({ 
                itemId: context.currentItemId, 
                includeProperties: ["VersionInfo.RevisionDate", "Title"] 
            });

            const pubInfo = await context.tools.getPublishInfo({ itemId: context.currentItemId });
            
            // Explicitly log why an item is excluded
            if (!pubInfo || pubInfo.length === 0) {
                console.warn(\`Skipped \${context.currentItemId}: Not published\`);
                return null;
            }
            
            // Check if stale...
            return { id: item.Id, title: item.Title, status: "Stale" };
        \`,
        postProcessingScript: \`
            return { 
                stalePages: context.successes.map(s => s.result).filter(r => r !== null),
                skippedCount: context.warnings.length 
            };
        \`,
        validationScript: \`
            if (context.output.stalePages.length > 0) {
                const sample = context.utils.sample(context.output.stalePages, 1);
                const check = await context.tools.getItem({ itemId: sample[0].id });
                context.utils.assert(check.Id === sample[0].id, "Audit Failed: Item ID mismatch");
            }
        \`
    });
    \`\`\`

    **Example 5: Import with Validation**
    Imports data, creates items, then audits the result.
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
            if (!context.hasSuccesses) return;
            
            // Strong Validation: Fetch the created item
            const sample = context.successes[0];
            const check = await context.tools.getItem({ itemId: sample.result.id });
            if (!check) throw new Error(\`Audit Failed: Created item \${sample.result.id} not found.\`);
            
            context.log("Audit Passed: Item exists.");
        \`
    });
    \`\`\`

    **Example 6: Compliance Report**
    Finds Pages published to Staging but not Live.
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        parameters: { "stagingId": "tcm:0-1-65537", "liveId": "tcm:0-2-65537" },
        preProcessingScript: \`
            const pages = await context.tools.getItemsInContainer({
               containerId: "tcm:0-5-1", itemTypes: ["Page"], recursive: true
            });
            return pages.map(p => p.Id);
        \`,
        mapScript: \`
            const info = await context.tools.getPublishInfo({ itemId: context.currentItemId });
            const onStaging = info.some(i => i.TargetType.IdRef === context.parameters.stagingId);
            const onLive = info.some(i => i.TargetType.IdRef === context.parameters.liveId);

            if (onStaging && !onLive) return { id: context.currentItemId, status: "Needs Live Publish" };
            return null;
        \`,
        postProcessingScript: \`
            // Reduce: Filter nulls and report
            return { itemsToReview: context.successes.map(s => s.result).filter(r => r !== null) };
        \`,
        validationScript: \`
             context.utils.assert(Array.isArray(context.results), "No results array produced");
        \`
    });
    \`\`\`

**Example 7: Advanced Cleanup - Large Unused Multimedia Report**
    Finds large Multimedia Components (images/videos) that are not used by any published Pages.
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        parameters: { "minFileSizeMB": 10 },
        preProcessingScript: \`
            // Setup: Find ALL components
            context.log('Finding ALL components in Publication...');
            const allItems = await context.tools.getItemsInContainer({
                containerId: "tcm:0-5-1", itemTypes: ["Component"], recursive: true, details: "IdAndTitle"
            });
            return allItems.map(item => item.Id);
        \`,
        mapScript: \`
            const minBytes = context.parameters.minFileSizeMB * 1024 * 1024;

            // 1. Fetch properties to identify type and size
            const item = await context.tools.getItem({ 
                itemId: context.currentItemId,
                includeProperties: ["Title", "ComponentType", "BinaryContent.Size"]
            });

            // 2. Filter: Must be Multimedia and Large
            if (!item || item.ComponentType !== 'Multimedia' || !item.BinaryContent) return null;
            if (item.BinaryContent.Size < minBytes) return null;

            context.log(\`Found large file: \${item.Title} (\${item.BinaryContent.Size} bytes)\`);

            // 3. Usage Check: Get dependency graph
            const graph = await context.tools.getDependencyGraph({
                itemId: context.currentItemId,
                direction: "UsedBy",
                rloItemTypes: ["Page"], // Only care about Page usages
                details: "IdAndTitle"
            });

            // Helper to recursively flatten graph
            function flattenPageIds(node) {
                let ids = [];
                if (!node) return ids;
                // If this node is a Page, add it
                if (node.Item && node.Item.ItemType === 'Page') ids.push(node.Item.Id);
                
                if (node.Dependencies) {
                    for (const child of node.Dependencies) {
                         ids = ids.concat(flattenPageIds(child));
                    }
                }
                return [...new Set(ids)];
            }
            
            const pageIds = flattenPageIds({ Dependencies: graph }); // Adapt based on tool output structure
            if (pageIds.length === 0) {
                 return { id: item.Id, title: item.Title, size: item.BinaryContent.Size, reason: "Unused by any Page" };
            }

            // 4. Check if any using Pages are published
            for (const pageId of pageIds) {
                const publishInfo = await context.tools.getPublishInfo({ 
                    itemId: pageId, includeProperties: ["PublishedAt"] 
                });
                
                // If even one using page is published, this asset is "Live" and shouldn't be touched.
                if (publishInfo && publishInfo.length > 0) return null;
            }
            
            return { id: item.Id, title: item.Title, size: item.BinaryContent.Size, reason: "Used only by unpublished Pages" };
        \`,
        postProcessingScript: \`
            // Reduce: Collect list of candidates for deletion
            const candidates = context.successes.map(s => s.result).filter(r => r !== null);
            return { 
                totalFilesToReview: candidates.length, 
                filesToReview: candidates 
            };
        \`,
        validationScript: \`
            if (!context.hasSuccesses) return;
            const report = context.output.filesToReview;
            if (!report || report.length === 0) {
                context.log("No large unused files found.");
                return;
            }

            // Audit a sample from the report
            const sample = context.utils.sample(report, 1)[0];
            context.log(\`Auditing reported file: \${sample.title}\`);

            // Verify it is actually a Large Multimedia component
            const check = await context.tools.getItem({ 
                itemId: sample.id,
                includeProperties: ["ComponentType", "BinaryContent"]
            });

            const minBytes = context.parameters.minFileSizeMB * 1024 * 1024;

            context.utils.assert(check.ComponentType === 'Multimedia', "Audit Failed: Item is not Multimedia");
            context.utils.assert(check.BinaryContent.Size >= minBytes, "Audit Failed: Item is smaller than threshold");

            context.log("Audit Passed: Item matches criteria.");
        \`
    });
    \`\`\`

    **Example 8: "Fail Loudly" Pattern (Handling Missing Dependencies)**
    Ensures that if a dependency is missing, the script throws an Error instead of silently continuing.
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        mapScript: \`
            const mapping = context.preProcessingResult.mapping;
            const targetId = mapping[context.currentItemId];
            
            // FAIL LOUDLY: Do not just return null or console.log.
            // Throwing an error ensures this item is counted as "failed" in the summary.
            if (!targetId) {
                throw new Error(\`Critical: No mapping found for item \${context.currentItemId}\`);
            }
            
            return await context.tools.addLink({ parentId: context.currentItemId, childId: targetId });
        \`,
        validationScript: \`
            if (context.hasFailures) {
                context.log(\`Operation had \${context.failures.length} failures. Check errors.\`);
            }
            // Audit successes
            if (context.hasSuccesses) {
                const sample = context.utils.sample(context.successes, 1);
                // ... verify link exists ...
            }
        \`
    });
    \`\`\`
`,

    input: toolOrchestratorInputProperties,

    execute: async (
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

        /** Helper to extract a clear error message. */
        const extractErrorMessage = (e: any): string => {
            try {
                if (!e) return 'Unknown error';
                if (e.message) return e.message;
                if (typeof e === 'string') return e;
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
                return JSON.stringify(e);
            } catch {
                return String(e);
            }
        }

        if (!mcpContext.tools || typeof mcpContext.tools !== 'object') {
            return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: "Tool execution context is missing. 'toolOrchestrator' cannot access other tools." }) }] };
        }

        const results: any[] = [];
        const logs: string[] = [];
        const log = (message: string) => logs.push(message);

        // --- Create Tool Wrappers ---
        const toolWrappers: { [toolName: string]: (args: any) => Promise<any> } = {};
        for (const toolName in mcpContext.tools) {
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

                const standardWrapper = async (args: any) => {
                    let validatedArgs = args || {};
                    if (toolInputProperties && typeof toolInputProperties === 'object') {
                        const toolInputSchema = z.object(toolInputProperties);
                        const validationResult = toolInputSchema.safeParse(validatedArgs);
                        if (!validationResult.success) {
                            throw new Error(`Invalid arguments for tool '${toolName}': ${validationResult.error.message}`);
                        }
                        validatedArgs = validationResult.data;
                    }

                    const result = await originalToolExecute(validatedArgs, mcpContext);

                    if (result && result.content && Array.isArray(result.content) &&
                        result.content[0] && result.content[0].type === 'text' &&
                        typeof result.content[0].text === 'string') {
                        const maybeText = result.content[0].text.trim();
                        if (maybeText.startsWith('{') || maybeText.startsWith('[')) {
                            try {
                                const parsedObject = JSON.parse(maybeText);
                                if (parsedObject && parsedObject.type === 'Error' && parsedObject.Message) {
                                    throw new Error(parsedObject.Message);
                                }
                                return parsedObject;
                            } catch (err) {
                                throw err;
                            }
                        }
                    }
                    if (result && typeof result === 'object' && !Array.isArray(result) && !result.content) {
                        return result;
                    }
                    return result;
                };

                // Idempotency Wrapper
                if (["createItem", "createPage", "createComponent", "createComponentSchema",
                    "createRegionSchema", "createMetadataSchema", "createPublication"].includes(toolName)) {
                    toolWrappers[toolName] = async (args: any) => {
                        try {
                            return await standardWrapper(args);
                        } catch (error: any) {
                            const errorMessage = (error?.message || error?.toString() || "").toLowerCase();
                            const errorContent = (error?.content) ? JSON.stringify(error.content).toLowerCase() : "";
                            const isConflict = (error?.status === 409) ||
                                errorMessage.includes("already exists") ||
                                errorMessage.includes("itemalreadyexists") ||
                                errorMessage.includes("status 409") ||
                                errorContent.includes("already exists") ||
                                errorContent.includes("itemalreadyexists");

                            if (!isConflict) throw error;
                            if (input.forceSkipIfPresent) {
                                return {
                                    type: "Skipped",
                                    Id: "Existing-Unknown",
                                    Message: "Item already exists. Skipped by request (forceSkipIfPresent=true).",
                                    Status: "Success (Skipped)"
                                };
                            }
                            throw new Error(`Idempotency Error: Item already exists. To skip existing items, set 'forceSkipIfPresent: true' in the tool parameters.`);
                        }
                    }
                } else {
                    toolWrappers[toolName] = standardWrapper;
                }
            }
        }

        const baseSandbox = createBaseSandbox();
        let finalItemIds: string[] = initialItemIds || [];
        let preScriptContextData: any = {};

        // --- Phase 1: Pre-Processing Logic (Setup Phase) ---
        if (preProcessingScript) {
            logs.push("Starting pre-processing script (setup phase)...");
            let compiledPreScript: vm.Script;
            try {
                compiledPreScript = new vm.Script(`(async () => { "use strict"; ${preProcessingScript} })();`, { filename: 'preProcessingScript.js' });
            } catch (error: any) {
                return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: `Pre-processing Script Compilation Error: ${extractErrorMessage(error)}` }) }] };
            }

            const preScriptLog = (message: string) => logs.push(`[PreScript] ${message}`);
            const preScriptContext: PreScriptContext = {
                parameters: Object.freeze(parameters),
                tools: toolWrappers,
                utils: scriptUtils,
                log: preScriptLog
            };
            const sandboxContext = { ...baseSandbox, context: preScriptContext, console: { log: preScriptLog } };
            const sandbox = vm.createContext(sandboxContext);
            try {
                const scriptPromise = compiledPreScript.runInContext(sandbox, { timeout: SYNC_SCRIPT_TIMEOUT_MS });
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Script timed out after ${TOTAL_SCRIPT_TIMEOUT_MS}ms`)), TOTAL_SCRIPT_TIMEOUT_MS));
                const preScriptResult = await Promise.race([scriptPromise, timeoutPromise]);

                if (Array.isArray(preScriptResult) && preScriptResult.every(item => typeof item === 'string')) {
                    finalItemIds = preScriptResult;
                } else if (typeof preScriptResult === 'object' && preScriptResult !== null && Array.isArray(preScriptResult.itemIds)) {
                    finalItemIds = preScriptResult.itemIds;
                    if (preScriptResult.preProcessingResult) preScriptContextData = Object.freeze(preScriptResult.preProcessingResult);
                }
                logs.push(`Pre-processing script finished. Found ${finalItemIds.length} items.`);
            } catch (error: any) {
                const errorMessage = extractErrorMessage(error);
                return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: `Pre-processing phase failed: ${errorMessage}` }) }] };
            }
        }

        if (finalItemIds.length === 0) {
            logs.push("No items provided or found during pre-processing. Skipping Map, Reduce, and Validation phases.");

            const emptyResult: OrchestratorResult = {
                status: "Completed",
                summary: "Operation completed: 0 items found to process.",
                processedItems: [],
                output: preScriptContextData // Pass along any setup data just in case
            };

            if (debug) {
                emptyResult.executionLog = logs.join('\n');
            }

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(emptyResult, null, 2)
                }],
            };
        }

        // --- Phase 2: Execution Logic (Map Phase) ---
        let wasStoppedOnError = false;

        if (!mapScript) {
            return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: "Items found but no mapScript provided." }) }] };
        }

        log(`\nStarting map phase for ${finalItemIds.length} items...`);
        let compiledMapScript: vm.Script;
        try {
            compiledMapScript = new vm.Script(`(async () => { "use strict"; ${mapScript} })();`, { filename: 'mapScript.js' });
        } catch (error: any) {
            return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: `Map Script Compilation Error: ${extractErrorMessage(error)}` }) }] };
        }

        const runTask = async (itemId: string, index: number): Promise<void> => {
            logs.push(`\n[${index + 1}/${finalItemIds.length}] Processing item: ${itemId}`);
            let itemHasWarning = false;
            let itemWarningMessage = "";

            const perItemLog = (message: string) => logs.push(`[${itemId}] ${message}`);
            const perItemWarnLog = (message: string) => { logs.push(`[${itemId}] [WARN] ${message}`); itemHasWarning = true; itemWarningMessage = message; };

            const perItemContext: MapScriptContext = {
                currentItemId: itemId,
                parameters: Object.freeze(parameters),
                preProcessingResult: preScriptContextData,
                tools: toolWrappers,
                utils: scriptUtils,
                log: perItemLog
            };
            const sandboxContext = { ...baseSandbox, context: perItemContext, console: { log: perItemLog, warn: perItemWarnLog, error: perItemLog } };
            const sandbox = vm.createContext(sandboxContext);

            try {
                const scriptPromise = compiledMapScript.runInContext(sandbox, { timeout: SYNC_SCRIPT_TIMEOUT_MS });
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Script timed out after ${TOTAL_SCRIPT_TIMEOUT_MS}ms`)), TOTAL_SCRIPT_TIMEOUT_MS));
                const result = await Promise.race([scriptPromise, timeoutPromise]);

                const safeResult = result === undefined ? "No return value" : result;

                if (itemHasWarning) {
                    results.push({ itemId, status: "warning", result: safeResult, warning: itemWarningMessage });
                } else {
                    results.push({ itemId, status: "success", result: safeResult });
                }
            } catch (error: any) {
                const errorMessage = extractErrorMessage(error);
                logs.push(`[${itemId}] FAILED: ${errorMessage}`);

                // Always record the failure
                results.push({ itemId: itemId, status: "error", error: errorMessage });

                if (stopOnError) {
                    // Mark global stop flag. The loop controller will handle the break.
                    wasStoppedOnError = true;
                }
            }
        };

        // Execution Loop
        if (maxConcurrency === 1) {
            for (const [index, itemId] of finalItemIds.entries()) {
                if (wasStoppedOnError) break; // STOP Condition
                await runTask(itemId, index);
            }
        } else {
            const workerPool = new Set<Promise<void>>();
            let index = 0;
            for (const itemId of finalItemIds) {
                if (wasStoppedOnError) break; // STOP Condition (prevents NEW tasks)

                while (workerPool.size >= maxConcurrency) {
                    await Promise.race(workerPool);
                }
                // Double check in case a worker failed while we were waiting
                if (wasStoppedOnError) break;

                const taskPromise = runTask(itemId, index++);
                const onFinally = () => workerPool.delete(taskPromise);
                taskPromise.then(onFinally, onFinally);
                workerPool.add(taskPromise);
            }
            await Promise.allSettled(Array.from(workerPool));
        }
        logs.push("\nMap phase finished.");

        // --- Categorize Results ---
        const successes = results.filter(r => r.status === 'success');
        const warnings = results.filter(r => r.status === 'warning');
        const failures = results.filter(r => r.status === 'error');

        // --- STOPPED ON ERROR EXIT ---
        if (wasStoppedOnError && failures.length > 0) {
            // We use the first failure as the "primary" reason for the stop,
            // but we acknowledge that concurrent threads may have produced other errors.
            const primaryFailure = failures[0];
            const otherFailures = failures.slice(1);

            let summaryText = `Execution stopped due to error on item '${primaryFailure.itemId}'.`;

            if (otherFailures.length > 0) {
                summaryText += ` ${otherFailures.length} other item(s) also failed concurrently (IDs: ${otherFailures.map(f => f.itemId).join(", ")}).`;
            }

            summaryText += ` Processed ${successes.length} items successfully before stop.`;

            const stoppedResult: OrchestratorResult = {
                status: "StoppedOnError",
                summary: summaryText,
                processedItems: successes.map(s => ({ id: s.itemId, result: s.result })),
                // We strictly map the structure to match the interface expected
                failedItem: { id: primaryFailure.itemId, error: primaryFailure.error }
            };

            // If debug is on, we can include the full details of all failures in the log
            if (debug) {
                (stoppedResult as any).executionLog = logs.join('\n');
                (stoppedResult as any).allFailures = failures;
            }

            return {
                content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: summaryText, Details: stoppedResult }, null, 2) }]
            };
        }

        // --- Phase 3: Post-Processing Logic (Reduce Phase) ---
        // Runs only if we completed the loop (even with failures, if stopOnError=false)
        let responsePayload: any = null;

        if (postProcessingScript) {
            logs.push("\nStarting post-processing script (reduce phase)...");
            let compiledPostScript: vm.Script;
            try {
                compiledPostScript = new vm.Script(`(async () => { "use strict"; ${postProcessingScript} })();`, { filename: 'postProcessingScript.js' });
            } catch (error: any) {
                return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: `Post-processing Script Compilation Error: ${extractErrorMessage(error)}` }) }] };
            }

            const postScriptLog = (message: string) => logs.push(`[PostScript] ${message}`);
            const sandboxContext = {
                ...baseSandbox,
                context: {
                    results: Object.freeze(results),
                    successes: Object.freeze(successes),
                    warnings: Object.freeze(warnings),
                    failures: Object.freeze(failures),
                    parameters: Object.freeze(parameters),
                    preProcessingResult: preScriptContextData,
                    tools: toolWrappers,
                    utils: scriptUtils,
                    log: postScriptLog
                },
                console: { log: postScriptLog }
            };
            const sandbox = vm.createContext(sandboxContext);
            try {
                const scriptPromise = compiledPostScript.runInContext(sandbox, { timeout: SYNC_SCRIPT_TIMEOUT_MS });
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Script timed out after ${TOTAL_SCRIPT_TIMEOUT_MS}ms`)), TOTAL_SCRIPT_TIMEOUT_MS));
                responsePayload = await Promise.race([scriptPromise, timeoutPromise]);
                logs.push("Post-processing script finished successfully.");
            } catch (error: any) {
                const postError: OrchestratorResult = {
                    status: "StoppedOnError",
                    summary: "Map phase completed, but Post-Processing script failed.",
                    processedItems: successes.map(s => ({ id: s.itemId, result: s.result })),
                    failedItem: { id: "PostProcessingScript", error: extractErrorMessage(error) }
                };
                return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: postError.summary, Details: postError }) }] };
            }
        } else {
            // Default Summary if no post-script
            responsePayload = {
                summary: "ToolOrchestrator Operation Completed",
                totalItemsProcessed: finalItemIds.length,
                succeeded: successes.length,
                warnings: warnings.length,
                failed: failures.length,
                results: includeScriptResults ? successes.map(r => ({ itemId: r.itemId, result: r.result })) : undefined
            };
        }

        // --- Phase 4: Validation Logic (Audit Phase) ---
        if (validationScript) {
            logs.push("\nStarting validation script (audit phase)...");
            let compiledValidationScript: vm.Script;
            try {
                compiledValidationScript = new vm.Script(`(async () => { "use strict"; ${validationScript} })();`, { filename: 'validationScript.js' });
            } catch (error: any) {
                return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: `Validation Script Compilation Error: ${extractErrorMessage(error)}` }) }] };
            }

            const valScriptLog = (message: string) => logs.push(`[Validation] ${message}`);
            const sandboxContext = {
                ...baseSandbox,
                context: {
                    output: Object.freeze(responsePayload),
                    results: Object.freeze(results),
                    successes: Object.freeze(successes),
                    warnings: Object.freeze(warnings),
                    failures: Object.freeze(failures),
                    hasSuccesses: successes.length > 0,
                    hasFailures: failures.length > 0,
                    hasWarnings: warnings.length > 0,
                    parameters: Object.freeze(parameters),
                    preProcessingResult: preScriptContextData,
                    tools: toolWrappers,
                    utils: scriptUtils,
                    log: valScriptLog
                },
                console: { log: valScriptLog }
            };
            const sandbox = vm.createContext(sandboxContext);
            try {
                const scriptPromise = compiledValidationScript.runInContext(sandbox, { timeout: SYNC_SCRIPT_TIMEOUT_MS });
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Script timed out after ${TOTAL_SCRIPT_TIMEOUT_MS}ms`)), TOTAL_SCRIPT_TIMEOUT_MS));
                const validationResult = await Promise.race([scriptPromise, timeoutPromise]);
                logs.push("Validation script finished successfully.");
                if (validationResult !== undefined) {
                    responsePayload = validationResult;
                }
            } catch (error: any) {
                const valError: OrchestratorResult = {
                    status: "StoppedOnError",
                    summary: "Operation and post-processing succeeded, but Validation failed.",
                    processedItems: successes.map(s => ({ id: s.itemId, result: s.result })),
                    output: responsePayload,
                    failedItem: { id: "ValidationScript", error: extractErrorMessage(error) }
                };
                return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: valError.summary, Details: valError }) }] };
            }
        }

        // --- Final Output Construction (Structured) ---
        // We wrap the final result (even if custom) in the OrchestratorResult envelope
        // to ensure the agent receives the standard structure requested.
        const finalStatus = failures.length > 0 ? "PartialSuccess" : "Completed";

        const finalOutput: OrchestratorResult = {
            status: finalStatus,
            summary: (typeof responsePayload === 'string') ? responsePayload : (responsePayload?.summary || `Operation ${finalStatus}`),
            processedItems: successes.map(s => ({ id: s.itemId, result: s.result })),
            output: responsePayload
        };

        if (debug) {
            let logOutput = logs;
            if (logs.length > 50) {
                logOutput = [...logs.slice(0, 25), `... (log truncated - ${logs.length - 50} lines hidden) ...`, ...logs.slice(-25)];
            }
            (finalOutput as any).executionLog = logOutput.join('\n');
        }

        return {
            content: [{
                type: "text",
                text: JSON.stringify(finalOutput, null, 2)
            }],
        };
    }
};
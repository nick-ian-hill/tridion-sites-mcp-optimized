import { z } from "zod";
import * as vm from 'vm';

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
const TOTAL_SCRIPT_TIMEOUT_MS = 60000; // 60 seconds

/**
 * A strict deny-list of tool names that *cannot* be passed to the sandboxed script.
 */
const DISALLOWED_TOOLS: string[] = [
    "toolOrchestrator",
    "deleteItem",
    "batchDelete",
    "createMultimediaComponentFromPrompt",
    "generateContentFromPrompt",
    "updateMultimediaComponentFromPrompt",
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


// Define the shape of the context object for the pre-processing script.
interface PreScriptContext {
    /** The JSON object passed to the 'parameters' input of the toolOrchestrator tool. */
    parameters: Record<string, any>;
    /** A dictionary of all available tools, wrapped for execution (e.g., `tools.search`, `tools.getItemsInContainer`). */
    tools: { [toolName: string]: (args: any) => Promise<any> };
    /** A function to log messages, which will be included in the final summary. */
    log: (message: string) => void;
}

// Define the shape of the context object for the main 'map' script.
interface MapScriptContext {
    /** The TCM URI of the item currently being processed in the loop. */
    currentItemId: string;
    /** The JSON object passed to the 'parameters' input of the toolOrchestrator tool. */
    parameters: Record<string, any>;
    /** A dictionary of all available tools, wrapped for execution (e.g., `tools.getItem`, `tools.updateContent`). */
    tools: { [toolName: string]: (args: any) => Promise<any> };
    /** A function to log messages, which will be included in the final summary. */
    log: (message: string) => void;
}

// This plain object defines the input properties, matching your other tools
const toolOrchestratorInputProperties = {
    itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/))
        .optional()
        .describe("An array of unique IDs (TCM URIs) for the items to be processed. This is required *unless* a 'preProcessingScript' is provided to generate the list."),
    preProcessingScript: z.string().optional()
        .describe("An optional first JavaScript string (as an async function body) that runs once *before* the main loop. It must return an array of item ID strings (string[]). This is the 'setup' phase, perfect for dynamically fetching or filtering the items to be processed (e.g., by calling 'context.tools.search(...)')."),
    mapScript: z.string()
        .describe("A JavaScript string (as an async function body) to execute for each item. The mapScript has access to a 'context' object. This is the 'map' phase."),
    postProcessingScript: z.string().optional()
        .describe("An optional second JavaScript string (as an async function body) that runs once after all items are processed. The script has access to two predefined variables: `results` (an array of all execution results from the 'map' phase) and `parameters` (the JSON object passed to the tool). Its return value becomes the final output of the tool. This is the 'reduce' phase."),
    parameters: z.record(z.any()).optional()
        .describe("An optional JSON object of parameters to pass into both the 'preProcessingScript' and the main 'mapScript'. Use this for static values like search queries or find/replace strings."),
    stopOnError: z.boolean().optional().default(true)
        .describe("If true (default), the entire operation stops if any single item fails during the 'map' phase. If false, it logs the error and continues to the next item."),
    maxConcurrency: z.number().int().min(1).max(10).optional().default(5)
        .describe("The maximum number of 'map' scripts to run in parallel. Set to 1 for sequential execution (e.g., for script validation and debugging, or if the server is under heavy load)."),
    includeScriptResults: z.boolean().optional().default(false)
        .describe("Controls whether the final output includes the individual results from the 'mapScript'. This parameter is ignored if a 'postProcessingScript' is provided. Set to 'true' for 'reporting' tasks where you want a list of all results. Leave 'false' for 'bulk update' tasks where you only care about the final summary."),
    debug: z.boolean().optional().default(false)
        .describe("If true, the full execution log is included in the JSON response. Defaults to false. Only consider setting this to true when debugging.")
};

const toolOrchestratorSchema = z.object(toolOrchestratorInputProperties).refine(
    (data) => (data.itemIds && data.itemIds.length > 0) || !!data.preProcessingScript,
    {
        message: "Either 'itemIds' must be provided with at least one item, or a 'preProcessingScript' must be provided to generate the item list.",
        path: ["itemIds"], // Associates the error with the itemIds field
    }
);

export const toolOrchestrator = {
    name: "toolOrchestrator",
    description: `Executes an advanced, multi-step JavaScript script. 
    
    This is the recommended tool for any task involving many items, especially aggregate queries (like "find the most..." or "count all..."). Using this tool for aggregation (e.g., running 'search' in 'preProcessingScript' and processing the results in 'postProcessingScript') is far more scalable, token-efficient and reliable than calling 'search' alone and processing a massive JSON result in the context window.
    
    The tool supports up to three phases:
    
    Phase 1 ('setup'): The optional 'preProcessingScript' runs once to dynamically fetch or filter the list of item IDs to be processed.
    Phase 2 ('map'): The main 'mapScript' runs for each item in the list generated by Phase 1 or provided via 'itemIds'.
    Phase 3 ('reduce'): The optional 'postProcessingScript' runs once on the collected results from Phase 2, allowing for aggregation, filtering, or sorting to find a final answer.

    By default, up to 5 scripts can run in parallel in the 'map' phase. Setting a higher 'maxConcurrency' value can increase speed at the cost of overall server load. Only use a value of 1 when debugging a script or when explicitly requested by the user.
    
The 'preProcessingScript' receives a 'context' object with:
- context.parameters (object): The JSON object you passed to the 'parameters' input.
- context.tools (object): A dictionary of all available tools (e.g., context.tools.search).
- context.log(message) (function): A function to log progress.
This script *must* return an array of item ID strings.

The mandatory 'mapScript' receives a 'context' object with:
- context.currentItemId (string): The ID of the item currently being processed.
- context.parameters (object): The JSON object you passed to the 'parameters' input.
- context.tools (object): A dictionary of all available tools (e.g., context.tools.getItem, context.tools.updateContent).
- context.log(message) (function): A function to log progress.

The optional 'postProcessingScript' receives a 'context' object with:
- context.results (array): The read-only array of all results from the 'map' phase.
- context.parameters (object): The JSON object you passed to the 'parameters' input.
- context.log(message) (function): A function to log progress.
This script's return value is the final output of the tool.

All scripts *must* be 'async' and can 'await' tool calls.
All tool calls (e.g., 'await context.tools.getItem(...)') are automatically authenticated.
For tools that return data (like 'getItem' or 'search'), the orchestrator will automatically parse the JSON response.
You will receive the data object directly, not a string that needs to be parsed.
For tools that return a simple message (like 'updateContent'), you will receive the full response object (e.g., { content: [{ type: "text", text: "Update successful." }] }).

To use the AI, call the 'generateContentFromPrompt' tool:
const aiResult = await context.tools.generateContentFromPrompt({ prompt: '...' });
const generatedText = aiResult.content[0].text;

Examples:

Example 1: Find and Replace in a Component Field (Map only)
This script finds 'Old Product Name' and replaces it with 'New Product Name' in the 'TextField' of several components. It runs up to 10 in parallel.

    const result = await tools.toolOrchestrator({
        itemIds: ["tcm:5-100", "tcm:5-101", "tcm:5-102"],
        parameters: {
            "find": "Old Product Name",
            "replace": "New Product Name"
        },
        maxConcurrency: 10,
        mapScript: \`
            // Get the item's content
            // The JSON is automatically parsed. 'item' is the data object.
            const item = await context.tools.getItem({ 
                itemId: context.currentItemId,
                includeProperties: ["Content.TextField"]
            });

            // Check and replace
            let content = item.Content;
            let updated = false;
            if (content && content.TextField && content.TextField.includes(context.parameters.find)) {
                content.TextField = content.TextField.replace(
                    new RegExp(context.parameters.find, 'g'), 
                    context.parameters.replace
                );
                updated = true;
                context.log('Found and replaced in content.');
            } else if (!content) {
                context.log('Item has no Content. Skipping.');
            }

            // Save changes if any
            if (updated) {
                // updateContent returns a standard wrapper, not JSON
                const updateResult = await context.tools.updateContent({
                    itemId: context.currentItemId,
                    content: content
                });
                context.log(updateResult.content[0].text);
            } else {
                context.log('No changes needed.');
            }
        \`
    });

Example 2: AI-Driven Content Rewrite (Map only)
This script uses the AI to rewrite the 'Summary' field of several articles to have a 'professional' tone. It runs sequentially (maxConcurrency: 1).

    const result = await tools.toolOrchestrator({
        itemIds: ["tcm:5-200", "tcm:5-201"],
        parameters: {
            "tone": "professional and engaging"
        },
        maxConcurrency: 1,
        mapScript: \`
            // Get the item's content
            // The JSON is automatically parsed.
            const item = await context.tools.getItem({ 
                itemId: context.currentItemId,
                includeProperties: ["Content.Summary"]
            });
            
            const originalSummary = item.Content ? item.Content.Summary : null;
            if (!originalSummary) {
                context.log('Item has no Content or Summary field. Skipping.');
                return;
            }
            context.log(\`Original summary: \${originalSummary.substring(0, 50)}...\`);

            // Use AI to rewrite the summary
            const aiPrompt = \`Rewrite the following summary to have a \${context.parameters.tone} tone:\\n\\n\${originalSummary}\`;
            // generateContentFromPrompt returns a simple text wrapper
            const aiResult = await context.tools.generateContentFromPrompt({ prompt: aiPrompt });
            const newSummary = aiResult.content[0].text;
            context.log(\`New summary: \${newSummary.substring(0, 50)}...\`);

            // Update the component
            item.Content.Summary = newSummary;
            await context.tools.updateContent({
                itemId: context.currentItemId,
                content: item.Content
            });
            context.log('Successfully updated with AI-generated content.');
        \`
    });

Example 3: Report on Component Schema and Author (Map only)
This script retrieves the Schema and Author (from metadata) for a list of components and returns this data.

    const result = await tools.toolOrchestrator({
        itemIds: ["tcm:5-300", "tcm:5-301"],
        includeScriptResults: true, // <-- Set to true to get the return values
        mapScript: \`
            // Get the item's data
            // The JSON is automatically parsed.
            const item = await context.tools.getItem({ 
                itemId: context.currentItemId,
                includeProperties: ["Schema.Title", "Metadata.author", "Info.LastModifiedDate"]
            });

            // BEST PRACTICE: Check if the item exists
                if (!item) {
                    context.log("Item not found or is inaccessible. Skipping.");
                    return null; // Return null to skip
                }

            const schemaTitle = item.Schema ? item.Schema.Title : "N/A";
            const author = item.Metadata ? item.Metadata.author : "N/A";
            const modified = item.Info ? item.Info.LastModifiedDate : "N/A";

            context.log(\`Item \${item.Id} uses Schema '\${schemaTitle}' and author is '\${author}'.\`);

            // Return a custom object. This will be in the 'Script Results' section.
            return { 
                schema: schemaTitle, 
                author: author,
                lastModified: modified
            };
        \`
    });

Example 4: Find Component with the Most Versions (Map and Reduce)
This script first gets the version count for each component, then the post-processing script finds the one with the highest count. This completes the entire task in a single tool call.

    const result = await tools.toolOrchestrator({
        itemIds: ["tcm:5-100", "tcm:5-101", "tcm:5-102"],
        mapScript: \`
            // Phase 2 (Map): Get version count for EACH item.
            // This script runs for every single item in the 'itemIds' array.

            // The JSON is automatically parsed.
            const history = await context.tools.getItemHistory({ itemId: context.currentItemId });
            
            // Return an object. This will be collected into an array for the next phase.
            return {
                versionCount: history.length,
                title: history[0].Title // Get title from the first version entry
            };
        \`,
        postProcessingScript: \`
            // Phase 3 (Reduce): Find the single best item from ALL results.
            // This script runs only ONCE, after the main script has finished for all items.
            // It receives the collected return values in the 'results' variable.
            
            context.log(\`Processing \${results.length} results.\`);
            
            if (!results || results.length === 0) {
                return "No results to process.";
            }

            // 'results' is an array like: [{ itemId: "tcm:5-100", status: "success", result: { versionCount: 5, title: "A" } }, ...]
            // We use the standard JavaScript reduce function to find the item with the highest versionCount.
            const componentWithMostVersions = results
                .filter(r => r.status === 'success') // Only check successful items
                .reduce((max, current) => {
                    // If the current item's version count is higher than the max we've seen so far, it becomes the new max.
                    if (current.result.versionCount > (max.result.versionCount || 0)) {
                        return current;
                    } else {
                        return max;
                    }
                }, { result: { versionCount: 0 } }); // Initial 'max' object

            // The return value of this script is the final output of the tool.
            return componentWithMostVersions;
        \`
    });

Example 5: Find and Process Items from a Search Result (Setup and Map)
This script uses the 'setup' phase to find all Components based on a specific Schema, and then the 'map' phase to update a field in each one.

    const result = await tools.toolOrchestrator({
        parameters: {
            "schemaId": "tcm:5-20-8", // The Schema to search for
            "newValue": "This content was bulk updated."
        },
        preProcessingScript: \`
            // Phase 1 (Setup): Find all components to process.
            context.log(\`Searching for Components based on Schema: \${context.parameters.schemaId}\`);

            // WARNING: tools.search() will NOT find changes that have not been checked-in, or items that do not yet have a major version.
            // If you need to process ALL items, use
            // context.tools.getItemsInContainer() instead.
            
            // The JSON is automatically parsed. 'items' is an array.
            const items = await context.tools.search({
                searchQuery: {
                    ItemTypes: ["Component"],
                    BasedOnSchemas: [{ schemaUri: context.parameters.schemaId }],
                    SearchIn: "tcm:0-5-1" // Search in '200 Example Content'
                },
                resultLimit: 500
            });

            // The pre-script MUST return an array of strings (item IDs)
            const itemIds = items.map(item => item.Id);
            
            context.log(\`Found \${itemIds.length} items to process.\`);
            return itemIds;
        \`,
        mapScript: \`
            // Phase 2 (Map): Update the 'TextField' for EACH item.
            await context.tools.updateContent({
                itemId: context.currentItemId,
                content: {
                    "TextField": context.parameters.newValue
                }
            });
            context.log("Content updated.");
        \`
    });

Example 6: Report on Items Modified Since Last Publish (Setup, Map, and Reduce)
This script finds all Pages in a Publication, checks, for each target type, whether the page has been modified since it was published, and returns a summary.
This is the correct, reliable way to answer "What's changed?".

    const result = await tools.toolOrchestrator({
        preProcessingScript: \`
            // Phase 1 (Setup): Find ALL pages in the Publication.
            // We use getItemsInContainer because tools.search() will
            // NOT return pages that do not yet have a major version,
            // which could cause this report to miss modified items.
            context.log('Finding ALL pages in Publication tcm:0-5-1...');
            
            const allItems = await context.tools.getItemsInContainer({
                containerId: "tcm:0-5-1",
                itemTypes: ["Page"],
                recursive: true,
                details: "IdAndTitle" // Most efficient
            });

            const itemIds = allItems.map(item => item.Id);
            context.log(\`Found \${itemIds.length} total Pages to check.\`);
            return itemIds;
        \`,
        mapScript: \`
            // Phase 2 (Map): Check modification vs. publish date for EACH target.
            
            const item = await context.tools.getItem({ 
                itemId: context.currentItemId,
                includeProperties: ["VersionInfo.RevisionDate", "Title"]
            });

            if (!item || !item.VersionInfo) {
                context.log("Item not found or lacks VersionInfo. Skipping.");
                return null;
            }
            const revisionDate = new Date(item.VersionInfo.RevisionDate);

            const publishInfos = await context.tools.getPublishInfo({ 
                itemId: context.currentItemId,
                includeProperties: ["PublishedAt", "TargetType.Title"] 
            });

            if (!publishInfos || publishInfos.length === 0) {
                context.log("No publish info found. Skipping item.");
                return null;
            }

            const modifiedOnTargets = [];
            for (const info of publishInfos) {
                if (info && info.PublishedAt && info.TargetType && info.TargetType.Title) {
                    const publishedAt = new Date(info.PublishedAt);
                    if (revisionDate > publishedAt) {
                        modifiedOnTargets.push(info.TargetType.Title);
                    }
                }
            }
            
            if (modifiedOnTargets.length > 0) {
                return {
                    id: context.currentItemId,
                    title: item.Title,
                    modifiedSince: revisionDate.toISOString(),
                    staleOnTargets: [...new Set(modifiedOnTargets)]
                };
            }
            
            return null; // Not modified on any target
        \`,
        postProcessingScript: \`
            // Phase 3 (Reduce): Collect the results into a final JSON summary.
            context.log(\`Aggregating \${results.length} results.\`);
            
            const modifiedItems = results
                .filter(r => r.status === 'success' && r.result !== null)
                .map(r => r.result);

            return {
                totalChecked: results.length,
                totalModified: modifiedItems.length,
                pagesWithStaleTargets: modifiedItems
            };
        \`
    });

Example 7: Robust Batch Operation with Error Reporting (stopOnError: false)
This script attempts to delete a list of items. It uses 'stopOnError: false' to ensure it tries all items, even if some fail (e.g., they are locked, already deleted, or cause a tool error). The post-script then provides a summary of successes and failures.

    const result = await tools.toolOrchestrator({
        itemIds: ["tcm:5-400", "tcm:5-9999", "tcm:5-401"], // Assume tcm:5-9999 does not exist
        stopOnError: false, // <-- Key hint: Continue processing even if one fails
        mapScript: \`
            // Phase 2 (Map): Attempt to delete one item.
            // If 'deleteItem' fails, the orchestrator will automatically catch
            // the error, log it, and add a { status: "error" } to the results.
            // Because 'stopOnError: false', it will then continue to the next item.
            context.log(\`Attempting to delete \${context.currentItemId}...\`);
            await context.tools.deleteItem({ itemId: context.currentItemId });
            return "Successfully deleted."; // This goes into 'result.result'
        \`,
        postProcessingScript: \`
            // Phase 3 (Reduce): Summarize successes and failures.
            // We can now just check the 'status' property set by the orchestrator.
            const successes = results.filter(r => r.status === 'success').length;
            const failures = results.filter(r => r.status === 'error').length;

            context.log(\`Batch complete with \${successes} successes and \${failures} failures.\`);

            // Collect details for the failed items
            const failedItems = results
                .filter(r => r.status === 'error')
                .map(r => ({ 
                    item: r.itemId, 
                    error: r.error // 'error' is automatically populated by the orchestrator
                }));

            // Return a final JSON summary object
            return {
                message: \`Batch delete complete. \${successes} succeeded, \${failures} failed.\`,
                successCount: successes,
                failureCount: failures,
                failedItems: failedItems
            };
        \`
    });
`,

    // The 'input' property is now the plain object
    input: toolOrchestratorInputProperties,

    execute: async (
        // Type inference for 'input' now uses the internal schema
        input: z.infer<typeof toolOrchestratorSchema>,
        mcpContext: any
    ) => {
        const { 
            itemIds: initialItemIds, 
            preProcessingScript, 
            mapScript, 
            postProcessingScript, 
            parameters = {}, 
            stopOnError, 
            maxConcurrency, 
            includeScriptResults,
            debug
        } = input;

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
            if (DISALLOWED_TOOLS.includes(toolName)) {
                continue;
            }

            if (mcpContext.tools[toolName] && mcpContext.tools[toolName].execute) {
                const originalToolExecute = mcpContext.tools[toolName].execute;
                toolWrappers[toolName] = async (args: any) => {
                    const result = await originalToolExecute(args || {}, mcpContext);
                    
                    // Check if the result looks like a standard JSON text response
                    if (result && result.content && Array.isArray(result.content) && 
                        result.content[0] && result.content[0].type === 'text' && 
                        result.content[0].text && 
                        (result.content[0].text.startsWith('{') || result.content[0].text.startsWith('['))) 
                    {
                        try {
                            // If it looks like JSON, parse it and return the data directly
                            return JSON.parse(result.content[0].text);
                        } catch (e) {
                            // It looked like JSON but failed to parse.
                            // Fall through to return the original object.
                        }
                    }
                    
                    // Fallback for:
                    // - Non-JSON text responses (e.g., "Update successful.")
                    // - Malformed JSON
                    // - Non-text responses (e.g., error objects)
                    return result;
                };
            }
        }

        // --- Create a secure base sandbox ---
        const baseSandbox = createBaseSandbox();

        let finalItemIds: string[] = initialItemIds || [];
        let hasFailed = false;

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
                    content: [{ type: "text", text: `Pre-processing Script Compilation Error: ${error.message}` }]
                };
            }
            
            const preScriptLog = (message: string) => logs.push(`[PreScript] ${message}`);
            const preScriptContext: PreScriptContext = {
                parameters: Object.freeze(parameters), // Freeze parameters for security
                tools: toolWrappers,
                log: preScriptLog
            };
            
            // Create a dedicated sandbox for this script
            const sandboxContext = { ...baseSandbox };
            sandboxContext.context = preScriptContext;
            sandboxContext.console = { log: preScriptLog, error: preScriptLog, warn: preScriptLog };
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

                if (!Array.isArray(preScriptResult) || !preScriptResult.every(item => typeof item === 'string')) {
                    const errorMsg = "Pre-processing script Error: The script must return an array of item ID strings (string[]).";
                    logs.push(errorMsg);
                    return { content: [{ type: "text", text: errorMsg + `\nReceived: ${JSON.stringify(preScriptResult)}` }] };
                }

                finalItemIds = preScriptResult;
                logs.push(`Pre-processing script finished. Found ${finalItemIds.length} items to process.`);

            } catch (error: any) {
                let errorMessage = `Pre-processing Script FAILED: ${String(error)}`;
                if (error instanceof Error) {
                    errorMessage = `Pre-processing Script FAILED: ${error.name}: ${error.message}`;
                }
                logs.push(errorMessage);
                return { content: [{ type: "text", text: `--- Execution Log ---\n${logs.join('\n')}` }] };
            }
        }

        // --- Phase 2: Execution Logic (Map Phase) ---
        log(`\nStarting map phase for ${finalItemIds.length} items with maxConcurrency: ${maxConcurrency}`);

        if (finalItemIds.length > 0) {
            
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
                    content: [{ type: "text", text: `Map Script Compilation Error: ${error.message}` }]
                };
            }

            // Create a mutable context object that will be updated for each item
            const perItemContext: MapScriptContext = {
                currentItemId: "", // Will be set by runTask
                parameters: Object.freeze(parameters),
                tools: toolWrappers,
                log: (message: string) => {} // Will be set by runTask
            };

            // Create the single, reusable sandbox
            const sandboxContext = { ...baseSandbox };
            sandboxContext.context = perItemContext;
            // We need a mutable console object for per-item logging
            sandboxContext.console = {
                log: (message: string) => {},
                error: (message: string) => {},
                warn: (message: string) => {}
            };
            
            const sandbox = vm.createContext(sandboxContext, {
                codeGeneration: { strings: false, wasm: false }
            });
            // --- End of single sandbox setup ---


            /**
             * A single, reusable function to run the script for one item
             * and handle logging, results, and errors.
             */
            const runTask = async (itemId: string, index: number): Promise<void> => {
                logs.push(`\n[${index + 1}/${finalItemIds.length}] Processing item: ${itemId}`);
                
                // --- Update the shared sandbox context ---
                const perItemLog = (message: string) => logs.push(`[${itemId}] ${message}`);
                perItemContext.currentItemId = itemId;
                perItemContext.log = perItemLog;
                sandboxContext.console.log = perItemLog;
                sandboxContext.console.error = perItemLog;
                sandboxContext.console.warn = perItemLog;
                // --- Context is updated ---

                try {
                    // Run the script in the *same* sandbox
                    const scriptPromise = compiledMapScript.runInContext(sandbox, {
                        timeout: SYNC_SCRIPT_TIMEOUT_MS
                    });
                    
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Script timed out after ${TOTAL_SCRIPT_TIMEOUT_MS}ms`)), TOTAL_SCRIPT_TIMEOUT_MS)
                    );

                    const result = await Promise.race([scriptPromise, timeoutPromise]);
                    results.push({
                        itemId: itemId,
                        status: "success",
                        result: (result === undefined) ? "No return value" : result
                    });
                    logs.push(`[${itemId}] Success.`);

                } catch (error: any) {
                    let errorMessage: string;
                    if (error && error.content && Array.isArray(error.content) && error.content[0]?.type === 'text') {
                        errorMessage = error.content[0].text;
                    } else if (error && error.data && error.data.content && Array.isArray(error.data.content) && error.data.content[0]?.type === 'text') {
                         errorMessage = error.data.content[0].text;
                    } else if (error instanceof Error) {
                        errorMessage = `${error.name}: ${error.message}`;
                    } else {
                        errorMessage = String(error);
                    }
                    
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
        } else {
            log("No items found to process. Skipping map phase.");
        }
        // --- End of Map Phase ---

        logs.push("\nMap phase finished.");
        
        // --- Phase 3: Post-Processing Logic (Reduce Phase) ---
        if (postProcessingScript) {
            logs.push("\nStarting post-processing script (reduce phase)...");
            
            let compiledPostScript: vm.Script;
            try {
                compiledPostScript = new vm.Script(`
                    (async () => {
                        "use strict";
                        // Make 'results' and 'parameters' available as global vars
                        // as described in the original tool's documentation
                        const results = context.results;
                        const parameters = context.parameters;
                        ${postProcessingScript}
                    })();
                `, { filename: 'postProcessingScript.js' });
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `Post-processing Script Compilation Error: ${error.message}` }]
                };
            }

            const postScriptLog = (message: string) => logs.push(`[PostScript] ${message}`);
            
            // Create a dedicated sandbox
            const sandboxContext = { ...baseSandbox };
            sandboxContext.context = {
                results: Object.freeze(results),
                parameters: Object.freeze(parameters),
                log: postScriptLog
            };
            sandboxContext.console = { log: postScriptLog, error: postScriptLog, warn: postScriptLog };
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

                let responsePayload: any = finalResult;

                if (debug) {
                    responsePayload = {
                        result: finalResult,
                        executionLog: logs.join('\n')
                    };
                }

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(responsePayload, null, 2)
                    }],
                };

            } catch (error: any)
            {
                const errorMessage = (error instanceof Error) ? `${error.name}: ${error.message}` : String(error);
                logs.push(`Post-Processing Script FAILED: ${errorMessage}`);
                // Return the log, even if post-processing fails
                const summary = `--- Execution Log ---\n${logs.join('\n')}`;
                return {
                    content: [{ type: "text", text: summary }],
                };
            }
        }
        // --- End of Post-Processing Logic ---
        
        // --- Final Summary (if no post-processing) ---
        const successCount = results.filter(r => r.status === 'success').length;
        const errorCount = results.filter(r => r.status === 'error').length;

        // Create a JSON summary object        
        const summaryObject: any = {
            summary: "ToolOrchestrator Summary",
            totalItemsProcessed: finalItemIds.length,
            succeeded: successCount,
            failed: errorCount
        };
        
        if (errorCount > 0) {
            summaryObject.errors = results
                .filter(r => r.status === 'error')
                .map(r => ({ itemId: r.itemId, error: r.error }));
        }

        if (includeScriptResults) {
            summaryObject.results = results
                .filter(r => r.status === 'success')
                .map(r => ({ itemId: r.itemId, result: r.result }));
        }

        if (debug) {
            summaryObject.executionLog = logs.join('\n');
        }
        return {
            content: [{
                type: "text",
                text: JSON.stringify(summaryObject, null, 2)
            }],
        };
    }
};
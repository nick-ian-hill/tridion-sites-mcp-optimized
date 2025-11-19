import { z } from "zod";
import * as vm from 'vm';
import { formatForAgent, formatForApi } from "../utils/fieldReordering.js";

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
    "batchDeleteItems",
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
    /** The 'preProcessingResult' object returned by the 'preProcessingScript' (if any). */
    preProcessingResult: any;
    /** A dictionary of all available tools, wrapped for execution (e.g., `tools.getItem`, `tools.updateContent`). */
    tools: { [toolName: string]: (args: any) => Promise<any> };
    /** A function to log messages, which will be included in the final summary. */
    log: (message: string) => void;
}

// This plain object defines the input properties, matching your other tools
const toolOrchestratorInputProperties = {
    itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/))
        .optional()
        .describe("An optional array of unique IDs (TCM URIs) to be processed. If provided, these are passed to the 'mapScript'. If a 'preProcessingScript' is also provided, the IDs returned by that script take precedence."),
    preProcessingScript: z.string().optional()
        .describe("An optional first JavaScript string (as an async function body) that runs once before the main loop. It must return either a string[] of item IDs, or an object { itemIds: string[], preProcessingResult?: any } to pass data to subsequent scripts. This is the 'setup' phase, perfect for dynamically fetching or filtering items, or for one-time setup operations (e.g. creating a folder structure)."),
    mapScript: z.string().optional()
        .describe("An optional JavaScript string (as an async function body) to execute for each item. The mapScript has access to a 'context' object. This is the 'map' phase. NOTE: Each item is processed in an isolated sandbox. This means you can safely use await and write parallel code (maxConcurrency > 1). If omitted, this phase is skipped."),
    postProcessingScript: z.string().optional()
        .describe("An optional second JavaScript string (as an async function body) that runs once after all items are processed (or immediately after the setup phase if no items/mapScript exist). The script has access to a 'context' object containing: `results` (an array of all execution results from the 'map' phase), `successes`, `failures`, `parameters` (the JSON object passed to the tool), and `preProcessingResult` (the 'context' object from the setup phase). Its return value becomes the final output of the tool. This is the 'reduce' phase."),
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

const toolOrchestratorSchema = z.object(toolOrchestratorInputProperties);

export const toolOrchestrator = {
    name: "toolOrchestrator",
    description: `Executes an advanced, multi-step JavaScript script. 
    
    This is the recommended tool for tasks involving repetitive actions on many items, especially aggregate queries (like "find the most...", "count all...", or "tabulate...").
    Using this tool for aggregation (e.g., running 'search' in 'preProcessingScript' and processing the results in 'postProcessingScript') is far more scalable, token-efficient and reliable than calling 'search', 'getActivities', 'getItemsInContainer', etc. directly and processing a massive JSON result in the context window.
    
    The tool supports up to three phases. You can mix and match these phases based on your needs (e.g., use only 'setup' for a one-off task, or 'setup' and 'reduce' without a 'map' phase).
    
    Phase 1 ('setup'): The optional 'preProcessingScript' runs once to dynamically fetch (e.g., via a publication-wide search with a suitably large resultLimit such as 25k) or filter the list of item IDs to be processed, or to perform one-time setup tasks.
    Phase 2 ('map'): The optional 'mapScript' runs for each item in the list generated by Phase 1 or provided via 'itemIds'. If no items are provided or this script is omitted, this phase is skipped.
    Phase 3 ('reduce'): The optional 'postProcessingScript' runs once on the collected results from Phase 2 (or just the data from Phase 1), allowing for aggregation, filtering, or sorting to find a final answer. An important role of this script is to ensure the response does not overwhelm the agent. Therefore, only return the data that is needed, and condense any error information to a few lines of text.

    By default, up to 5 scripts can run in parallel in the 'map' phase. Setting a higher 'maxConcurrency' value can increase speed at the cost of overall server load. Only use a value of 1 when debugging a script or when explicitly requested by the user.

    RECOMMENDED STRATEGY FOR COMPLEX TASKS
    For complex, multi-stage tasks (like bulk-importing relational data from an Excel file), it is highly recommended to break the operation into separate, sequential 'toolOrchestrator' calls.
    For example:
    1.  Call 1: Create all shared prerequisites (Schemas, Folders, etc.) and all unique *dependencies* (e.g., all "Article" Components).
    2.  Call 2: Take the results of Call 1 (e.g., the map of created Component IDs) and create the *consumers* (e.g., all the "Pages") in parallel, linking to the items from Call 1.
    
    This 'multi-call' pattern (demonstrated in Example 12) is the most robust strategy. It avoids script timeouts by parallelizing work in the 'map' phase, and it prevents race conditions by creating all shared dependencies before they are consumed.
    
    Trying to create both dependencies and consumers in a single, parallel 'mapScript' is an advanced technique that can lead to race conditions (e.g., two scripts trying to create the same component) and is not recommended.
    
    DEBUGGING STRATEGIES
    This is a powerful tool. For any complex script, or if you get an error, follow this debugging process:
    
    1.  Test on a Single Item: Do not run your script on 500 items at once. First, run it with a single, non-critical item (e.g.,'itemIds': ["tcm:5-100"]).
    2.  Set 'maxConcurrency: 1'. This makes the execution log sequential and easy to read.
    3.  Set 'debug: true. This includes a streamlined execution log in the response so you can see what happened.
    4.  Inspect the Result: This single-item test will either succeed, proving your tool calls and parameter logic are valid, or it will fail, giving you a specific, real-world error from the API.
    5.  Use 'context.log()' calls in your scripts to check variables and data. These will appear in the debug log.
    
    Only after you have confirmed the single-item test works should you run the script on your full list of 'itemIds'.

The 'preProcessingScript' receives a 'context' object with:
- context.parameters (object): The JavaScript object you passed to the 'parameters' input.
- context.tools (object): A dictionary of all available tools (e.g., context.tools.search).
- context.log(message) (function): A function to log progress.
This script *must* return either:
1. An array of item ID strings (string[]).
2. An object: { itemIds: string[], preProcessingResult?: any }. The preProcessingResult object is passed to the 'map' and 'post' scripts as context.preProcessingResult. Any data or objects you add to preProcessingResult (e.g., preProcessingResult: { myData: [...] }) are passed as live JavaScript objects. You can access them directly (e.g., context.preProcessingResult.myData) with no JSON.parse() required.

The optional 'mapScript' receives a 'context' object with:
- context.currentItemId (string): The ID of the item currently being processed.
- context.parameters (object): The JavaScript object you passed to the 'parameters' input.
- context.preProcessingResult (any): The live JavaScript object returned by the preProcessingScript (if any). No JSON.parse() is needed.
- context.tools (object): A dictionary of all available tools (e.g., context.tools.getItem, context.tools.updateContent).
- context.log(message) (function): A function to log progress.

The optional 'postProcessingScript' receives a 'context' object with:
- context.results (array): The read-only array of all results from the 'map' phase.
- context.successes (array): A pre-filtered array of all successful results ({ status: 'success', ... }).
- context.failures (array): A pre-filtered array of all failed results ({ status: 'error', ... }).
- context.parameters (object): The JavaScript object you passed to the 'parameters' input.
- context.preProcessingResult (any): The live JavaScript object returned by the preProcessingScript (if any). No JSON.parse() is needed.
- context.tools (object): A dictionary of all available tools (e.g., context.tools.getItem, context.tools.updateContent).
- context.log(message) (function): A function to log progress.
This script's return value is the final output of the tool.

All scripts must be 'async' and can 'await' tool calls.
All tool calls (e.g., 'await context.tools.getItem(...)') are automatically authenticated.

Automatic JSON parsing
All tools have their JSON string responses automatically parsed into JavaScript objects. You do not need to parse tool responses in a script.

// Example of correct usage inside toolOrchestrator:
const item = await context.tools.getItem({ itemId: 'tcm:1-234-64' });
if (item) {
  context.log("Item title: " + item.Title + ", type: " + item.type);
}

To use the AI, call the 'generateContentFromPrompt' tool:
const aiResult = await context.tools.generateContentFromPrompt({ prompt: '...' });
const generatedText = aiResult.Content;

Note that calling one of the following tools in a toolOrchestrator script is disallowed and will result in an error:
    - toolOrchestrator,
    - deleteItem,
    - batchDeleteItems

Note on Script Limits:
All scripts are sandboxed for security and stability.
A single script is not allowed to run synchronous (blocking) code for more than 5 seconds,
and no single script (including all its await calls) can run for more than 60 seconds.
This is to prevent runaway scripts. For processing large numbers of items, always use the mapScript phase.

Best practice for passing complex Data (like Excel/Search Results):
DO NOT pass large JSON strings via the parameters object. This is inefficient and requires manual JSON.parse(), which can lead to errors.
The correct method is to fetch the data inside the preProcessingScript and pass the parsed object to the other scripts via the context return value.

Note: IDs (e.g., "tcm:5-100", "tcm:0-5-1") used in the following examples are fictional.
NEVER hardcode these IDs in your scripts.
You can use the 'preProcessingScript' (Phase 1) to dynamically discover real IDs based on the user's request (e.g., using 'search', 'getItemsInContainer', or 'getPublications').

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
            
            // BEST PRACTICE: Check if the item exists
            if (!item) {
                context.log("Item not found or is inaccessible. Skipping.");
                return; // Stop execution for this item
            }

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
            // updateContent returns a JSON object with the update status
                const updateResult = await context.tools.updateContent({
                    itemId: context.currentItemId,
                    content: content
                });
                // The JSON is automatically parsed, so we access its 'Message' property
                context.log(updateResult.Message);
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

            // BEST PRACTICE: Check if the item exists
            if (!item) {
                context.log("Item not found or is inaccessible. Skipping.");
                return; // Stop execution for this item
            }
            
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
            context.log(\`Processing \${context.results.length} total results (\${context.successes.length} success, \${context.failures.length} fail).\`);

            if (context.failures.length > 0) {
                context.log(\`Warning: \${context.failures.length} items failed to process.\`);
                // You could even log the specific errors
                // for (const failure of context.failures) {
                //    context.log(\`  - \${failure.itemId}: \${failure.error}\`);
                // }
            }

            // 3. Check if there are ANY successes to process
            if (context.successes.length === 0) {
                context.log("No items were processed successfully.");
                
                // Return a meaningful error object instead of a default value
                return {
                    message: "Could not determine component with most versions: All item operations failed.",
                    totalItems: context.results.length,
                    successCount: 0,
                    failureCount: context.failures.length,
                    // Optionally include the specific failure details
                    failures: context.failures.map(f => ({ item: f.itemId, error: f.error }))
                };
            }
            
            // 4. If we are here, we have at least one success.
            //    We can now safely run the 'reduce' logic.
            context.log(\`Finding max versions from \${context.successes.length} successful items.\`);

            const componentWithMostVersions = context.successes
                .reduce((max, current) => {
                    // Get counts, with a fallback for safety
                    const currentVersions = current.result?.versionCount || 0;
                    const maxVersions = max.result?.versionCount || 0;
                    
                    if (currentVersions > maxVersions) {
                        return current; // This item is the new max
                    } else {
                        return max; // Keep the existing max
                    }
                }); // No initial value is needed, since we know the array is not empty.

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
            // Therefore, when searching for versioned items (e.g., Components, Pages, Schemas), use the less efficient
            // context.tools.getItemsInContainer() instead to guarantee no relevant items are missed.
            
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

Example 6: Comprehensive "Stale Content" Report (Checks all Dependencies)
This script finds all Pages in a Publication and checks if they OR any of their dependent items (components, images, etc.) have been modified since the last publish date.
This is the most robust and accurate way to find stale content.

    const result = await tools.toolOrchestrator({
        preProcessingScript: \`
            // Phase 1 (Setup): Find ALL pages in the Publication.
            // We use getItemsInContainer because tools.search() will
            // NOT return pages that do not yet have a major version.
            context.log('Finding ALL pages in Publication tcm:0-5-1...');
            
            const allItems = await context.tools.getItemsInContainer({
                containerId: "tcm:0-5-1",
                itemTypes: ["Page"],
                recursive: true,
                details: "IdAndTitle"
            });

            const itemIds = allItems.map(item => item.Id);
            context.log(\`Found \${itemIds.length} total Pages to check.\`);
            return itemIds;
        \`,
        mapScript: \`
            context.log(\`Checking Page: \${context.currentItemId}\`);
            
            // 1. Get Page's own info
            const item = await context.tools.getItem({ 
                itemId: context.currentItemId,
                includeProperties: ["Title", "VersionInfo.RevisionDate"]
            });

            if (!item || !item.VersionInfo) {
                context.log("Page not found or lacks VersionInfo. Skipping.");
                return null;
            }
            context.log(\`  Page Title: \${item.Title}\`);

            // 2. Get Publish info for the Page
            const publishInfos = await context.tools.getPublishInfo({ 
                itemId: context.currentItemId,
                includeProperties: ["PublishedAt", "TargetType.Title"] 
            });

            if (!publishInfos || publishInfos.length === 0) {
                context.log("  No publish info found. Skipping page.");
                return null; // Page has never been published
            }

            // 3. Get *all* dependencies (direct and indirect)
            context.log('  Fetching dependency graph...');
            
            // Helper function to flatten the dependency graph tree
            function flattenDependencies(node) {
                let items = [];
                if (node.Dependencies && node.Dependencies.length > 0) {
                    for (const childNode of node.Dependencies) {
                        if (childNode.Item) {
                            items.push(childNode.Item);
                        }
                        // Recurse
                        items = items.concat(flattenDependencies(childNode));
                    }
                }
                return items;
            }

            let dependencyDetails = [];
            try {
                // Get the graph object *directly*
                const graph = await context.tools.dependencyGraphForItem({
                    itemId: context.currentItemId,
                    direction: "Uses", // Get items this page *uses*
                    // Ask for the details we need directly
                    includeProperties: ["Title", "VersionInfo.RevisionDate"]
                });
                
                if (graph && graph.Dependencies) {
                    // Flatten the tree structure to get a simple list of items
                    dependencyDetails = flattenDependencies(graph);
                    context.log(\`  Found \${dependencyDetails.length} total dependencies.\`);
                } else {
                    context.log(\`  No dependencies found or graph was invalid.\`);
                    dependencyDetails = [];
                }
            } catch (e) {
                context.log(\`  ERROR: Failed to get dependency graph: \${e.message}\`);
                return null;
            }

            // 5. Find the single LATEST modification date
            let latestModificationDate = new Date(item.VersionInfo.RevisionDate);
            let latestModifiedItem = { 
                title: \`\${item.Title} (Page)\`, 
                date: latestModificationDate 
            };

            for (const comp of dependencyDetails) {
                if (comp && comp.VersionInfo && comp.VersionInfo.RevisionDate) {
                    const compRevisionDate = new Date(comp.VersionInfo.RevisionDate);
                    if (compRevisionDate > latestModificationDate) {
                        latestModificationDate = compRevisionDate;
                        latestModifiedItem = { 
                            title: \`\${comp.Title} (\${comp.Id})\`, 
                            date: latestModificationDate 
                        };
                    }
                }
            }
            context.log(\`  Latest modification: \${latestModificationDate.toISOString()} from "\${latestModifiedItem.title}"\`);
            
            // 6. Loop through each target and do one simple comparison
            const staleOnTargets = {};
            for (const info of publishInfos) {
                if (!info || !info.PublishedAt || !info.TargetType || !info.TargetType.Title) {
                    continue;
                }
                
                const targetName = info.TargetType.Title;
                const publishedAt = new Date(info.PublishedAt);
                context.log(\`  -> Checking Target: "\${targetName}", Published: \${publishedAt.toISOString()}\`);

                if (latestModificationDate > publishedAt) {
                    context.log('     Comparison: TRUE (Stale)');
                    staleOnTargets[targetName] = {
                        reason: 'Content modified',
                        staleItem: latestModifiedItem.title,
                        modifiedDate: latestModificationDate.toISOString(),
                        publishedDate: publishedAt.toISOString()
                    };
                } else {
                    context.log('     Comparison: FALSE (Up to date)');
                }
            }
            
            // 7. Return a result ONLY if any target was found to be stale
            if (Object.keys(staleOnTargets).length > 0) {
                return {
                    id: context.currentItemId,
                    title: item.Title,
                    staleTargets: staleOnTargets
                };
            }
            
            return null; // Not stale on any target
        \`,
        postProcessingScript: \`
            context.log(\`Aggregating \${context.results.length} results.\`);
            // Use the pre-filtered 'successes' array
            const modifiedItems = context.successes
                .filter(r => r.result !== null)
                .map(r => r.result);

            return {
                totalChecked: context.results.length,
                totalStalePages: modifiedItems.length,
                stalePages: modifiedItems
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
            const successCount = context.successes.length;
            const failureCount = context.failures.length;

            context.log(\`Batch complete with \${successCount} successes and \${failureCount} failures.\`);

            // Collect details for the failed items
            const failedItems = context.failures
                .map(r => ({ 
                    item: r.itemId, 
                    error: r.error // 'error' is automatically populated by the orchestrator
                }));

            // Return a final JSON summary object
            return {
                message: \`Batch delete complete. \${successCount} succeeded, \${failureCount} failed.\`,
                successCount: successCount,
                failureCount: failureCount,
                failedItems: failedItems
            };
        \`
    });

Example 8: Report Pages Published to Staging but Not Live
This script finds all Pages in a Publication, efficiently gets the required Target Type IDs once in the setup phase, and then checks the publish status of each page against those specific IDs.

    const result = await tools.toolOrchestrator({
        parameters: {
            "publicationTitle": "400 Example Site",
            "stagingTargetTitle": "DXA Staging",
            "liveTargetTitle": "DXA Live"
        },
        // Phase 1 (Setup): Find pages and Target Type IDs ONCE
        preProcessingScript: \`
            context.log(\`Setup: Finding Pub ID for '\${context.parameters.publicationTitle}'...\`);
            const publications = await context.tools.getPublications({ details: "IdAndTitle" });
            const publication = publications.find(p => p.Title === context.parameters.publicationTitle);
            if (!publication) throw new Error(\`Publication '\${context.parameters.publicationTitle}' not found.\`);
            context.log(\`Pub ID: \${publication.Id}\`);

            context.log('Setup: Finding Target Type IDs...');
            const targetTypes = await context.tools.getTargetTypes({ details: "IdAndTitle" });
            const stagingTarget = targetTypes.find(t => t.Title === context.parameters.stagingTargetTitle);
            const liveTarget = targetTypes.find(t => t.Title === context.parameters.liveTargetTitle);
            if (!stagingTarget) throw new Error(\`Target Type '\${context.parameters.stagingTargetTitle}' not found.\`);
            if (!liveTarget) throw new Error(\`Target Type '\${context.parameters.liveTargetTitle}' not found.\`);
            context.log(\`Staging ID: \${stagingTarget.Id}, Live ID: \${liveTarget.Id}\`);

            context.log('Setup: Finding all Pages in Publication...');
            const pages = await context.tools.getItemsInContainer({
                containerId: publication.Id,
                itemTypes: ["Page"],
                recursive: true,
                details: "IdAndTitle"
            });
            const pageIds = pages.map(p => p.Id);
            context.log(\`Found \${pageIds.length} Pages.\`);

            // Return object containing itemIds and the target IDs for the map script
            return {
                itemIds: pageIds,
                preProcessingResult: { // <-- This object is passed to map/post scripts
                    stagingTargetId: stagingTarget.Id,
                    liveTargetId: liveTarget.Id
                }
            };
        \`,
        // Phase 2 (Map): Check publish status using IDs from preProcessingResult
        mapScript: \`
            const pageId = context.currentItemId;
            context.log(\`Map: Checking publish info for Page \${pageId}...\`);

            // Access Target IDs passed from the setup phase's 'preProcessingResult' object
            const stagingId = context.preProcessingResult.stagingTargetId;
            const liveId = context.preProcessingResult.liveTargetId;

            const publishInfo = await context.tools.getPublishInfo({
                itemId: pageId,
                // Use 'IdRef' to get the ID from the TargetType Link object
                includeProperties: ["TargetType.IdRef", "PublishedAt"]
            });

            // Check if published to Staging (using IdRef)
            const isPublishedToStaging = publishInfo.some(info => info.TargetType && info.TargetType.IdRef === stagingId);
            // Check if published to Live (using IdRef)
            const isPublishedToLive = publishInfo.some(info => info.TargetType && info.TargetType.IdRef === liveId);
            context.log(\`  Staging: \${isPublishedToStaging}, Live: \${isPublishedToLive}\`);

            // If published to Staging BUT NOT to Live, return details
            if (isPublishedToStaging && !isPublishedToLive) {
                context.log(\`  Condition MET. Getting page title...\`);
                const page = await context.tools.getItem({ itemId: pageId, includeProperties: ["Title"] });
                return { title: page.Title, id: page.Id };
            }

            // Otherwise, return null (will be filtered out later)
            context.log('  Condition NOT MET.');
            return null;
        \`,
        // Phase 3 (Reduce): Format the results
        postProcessingScript: \`
            context.log('Reduce: Filtering and formatting results...');
            const pages = context.successes
                .filter(r => r.result !== null)
                .map(r => r.result);
            context.log(\`Found \${pages.length} pages matching criteria.\`);

            if (pages.length === 0) {
                return \`No pages found in '\${context.parameters.publicationTitle}' that are published to '\${context.parameters.stagingTargetTitle}' but not to '\${context.parameters.liveTargetTitle}'.\`;
            }

            let report = \`Found \${pages.length} pages published to '\${context.parameters.stagingTargetTitle}' but not '\${context.parameters.liveTargetTitle}':\\n\`;
            for (const page of pages) {
                report += \`- \${page.title} (\${page.id})\\n\`;
            }
            return report.trim();
        \`
    });

Example 9: Create a 'Diamond' BluePrint Hierarchy (Setup only)
This script uses the 'preProcessingScript' to perform a complex, one-time setup: creating a full BluePrint hierarchy. It creates a Root Publication, adds the required Root Structure Group, and then creates a 'diamond' inheritance pattern (a Website inheriting from separate Schema and Content Publications). The 'mapScript' is skipped (omitted), and the 'postProcessingScript' returns a final summary.
Note: This script assumes the Publication titles are unique. Publication titles must be globally unique, and the script will fail with a 409 Conflict error if a Publication with one of these titles already exists. Verify uniqueness using getPublications before creating and running the script.

    const result = await tools.toolOrchestrator({
        preProcessingScript: \`
            // --- Phase 1: Setup ---
            context.log("Starting BluePrint 'Diamond Pattern' setup...");

            // 1. Create Root Publication
            // The orchestrator automatically parses the JSON response.
            const rootPub = await context.tools.createPublication({
                title: "010 Global Master (Root)",
                publicationUrl: "/master",
                locale: "en-US"
            });
            // We can access the 'Id' property directly from the returned object.
            const rootPubId = rootPub.Id;
            if (!rootPubId) throw new Error("Failed to create Root Publication.");
            context.log(\`Created Root Publication: \${rootPubId}\`);

            // 2. Create Root Structure Group (REQUIRED for BluePrinting)
            // A Publication must have a Root Structure Group to be a parent.
            // No need to capture the ID, but we check for success
            const rootSg = await context.tools.createRootStructureGroup({
                title: "Root",
                publicationId: rootPubId 
            });
            if (!rootSg.Id) throw new Error("Failed to create Root Structure Group.");
            context.log(\`Created Root Structure Group in \${rootPubId}\`);

            // 3. Create Schema Master (inherits from Root). Used for Component Schemas, Embedded Schemas, Categories, and Keywords.
            const schemaPub = await context.tools.createPublication({
                title: "020 Schema Master",
                parentPublications: [rootPubId],
                publicationType: "Content"
            });
            const schemaPubId = schemaPub.Id;
            if (!schemaPubId) throw new Error("Failed to create Schema Master.");
            context.log(\`Created Schema Master Publication: \${schemaPubId}\`);

            // 4. Create Design Master (inherits from Root). Used for Component Templates, Page Templates, Template Building Blocks, and Region Schemas.
            const designPub = await context.tools.createPublication({
                title: "030 Design Master",
                parentPublications: [rootPubId],
                publicationType: "Content"
            });
            const designPubId = designPub.Id;
            if (!designPubId) throw new Error("Failed to create Design Master.");
            context.log(\`Created Design Master Publication: \${designPubId}\`);

            // 5. Create Website (inherits from Schema AND Design)
            // This forms the 'diamond' shape.
            const websitePub = await context.tools.createPublication({
                title: "100 Global Website",
                parentPublications: [schemaPubId, designPubId], // <-- Inherits from two parents
                publicationUrl: "/global",
                locale: "en-US",
                publicationType: "Web"
            });
            const websitePubId = websitePub.Id;
            if (!websitePubId) throw new Error("Failed to create Website Publication.");
            context.log(\`Created Website Publication: \${websitePubId}\`);

            context.log("Diamond BluePrint setup complete.");

            // Return the IDs of the created publications.
            // Note: 'itemIds' is intentionally returned as an empty array (or could be omitted) 
            // because we have no map phase.
            return {
                itemIds: [], 
                preProcessingResult: { // <-- Pass data to post-processing
                    root: rootPubId,
                    schema: schemaPubId,
                    design: designPubId,
                    website: websitePubId
                }
            };
        \`,
        // NO 'mapScript' is provided.
        postProcessingScript: \`
            // 'context.preProcessingResult' holds the object returned from the setup phase
            // (which in this case contains the new Publication IDs).
            const createdIds = context.preProcessingResult;
            
            const summary = {
                message: "Successfully created 'Diamond' BluePrint hierarchy.",
                publications: [
                    { role: "Root", id: createdIds.root },
                    { role: "Schema Master", id: createdIds.schema },
                    { role: "Design Master", id: createdIds.design },
                    { role: "Website (Child)", id: createdIds.website }
                ]
            };

            context.log(JSON.stringify(summary, null, 2));
            
            // The return value of this script is the final output.
            return summary;
        \`
    });

Example 10: Generate "Missing Alt Text" Report for Images
    This script finds all image components in a Publication, then "fetches" the full data for each one
    to inspect its MimeType and Metadata fields for alt text.

    const result = await tools.toolOrchestrator({
        preProcessingScript: \`
            // Phase 1 (Setup): Find ALL components in the Publication.
            context.log('Finding ALL components in Publication tcm:0-5-1...');
            const allItems = await context.tools.getItemsInContainer({
                containerId: "tcm:0-5-1",
                itemTypes: ["Component"],
                recursive: true,
                details: "IdAndTitle"
            });
            const itemIds = allItems.map(item => item.Id);
            context.log(\`Found \${itemIds.length} total Components to check.\`);
            return itemIds;
        \`,
        mapScript: \`
            // Phase 2 (Map): Fetch and inspect EACH component.
            const itemId = context.currentItemId;
            context.log(\`Checking: \${itemId}\`);
            
            // 1. Fetch the full item data, including Metadata and BinaryContent
            const item = await context.tools.getItem({ 
                itemId: itemId,
                // We MUST include these properties to check them
                includeProperties: ["Title", "ComponentType", "BinaryContent.MimeType", "Metadata"]
            });

            // 2. Filter for Images
            if (!item || item.ComponentType !== 'Multimedia') {
                context.log("  -> Not a Multimedia Component. Skipping.");
                return null;
            }
            const mimeType = item.BinaryContent ? item.BinaryContent.MimeType : '';
            const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp'];
            if (!allowedTypes.includes(mimeType)) {
                context.log(\`  -> Not an image (MimeType: \${mimeType}). Skipping.\`);
                return null;
            }

            // 3. Inspect Metadata for 'alt' or 'description'
            const metadata = item.Metadata;
            if (!metadata) {
                context.log("  -> Is image, but has NO Metadata block. Adding to report.");
                return { id: item.Id, title: item.Title, reason: "Missing Metadata block" };
            }

            // Find a field with 'alt' or 'description' in its name
            const altFieldKey = Object.keys(metadata).find(key => 
                key.toLowerCase().includes('alt') || key.toLowerCase().includes('description')
            );

            if (!altFieldKey) {
                context.log("  -> Is image, but has NO field matching 'alt' or 'description'. Adding to report.");
                return { id: item.Id, title: item.Title, reason: "No 'alt' or 'description' field" };
            }

            // Check if the found field is empty
            const altValue = metadata[altFieldKey];
            if (!altValue || (typeof altValue === 'string' && altValue.trim() === '')) {
                context.log(\`  -> Is image, has field '\${altFieldKey}', but it is EMPTY. Adding to report.\`);
                return { id: item.Id, title: item.Title, reason: \`Empty '\${altFieldKey}' field\` };
            }

            context.log(\`  -> OK: Found '\${altFieldKey}' with value.\`);
            return null; // This item is compliant
        \`,
        postProcessingScript: \`
            // Phase 3 (Reduce): Collect all non-compliant items
            context.log('Aggregating report...');
            const nonCompliantItems = context.successes
                .filter(r => r.result !== null)
                .map(r => r.result);

            return {
                totalChecked: context.results.length,
                totalNonCompliant: nonCompliantItems.length,
                itemsToFix: nonCompliantItems
            };
        \`
    });

Example 11: Find Large, Unused Multimedia Components
    This script finds all Components, filters them by size, and then checks if they are used by any *published* Page.

    const result = await tools.toolOrchestrator({
        parameters: {
            "minFileSizeMB": 10
        },
        preProcessingScript: \`
            // Phase 1 (Setup): Find ALL components in the Publication.
            context.log('Finding ALL components in Publication tcm:0-5-1...');
            const allItems = await context.tools.getItemsInContainer({
                containerId: "tcm:0-5-1",
                itemTypes: ["Component"],
                recursive: true,
                details: "IdAndTitle"
            });
            const itemIds = allItems.map(item => item.Id);
            context.log(\`Found \${itemIds.length} total Components to check.\`);
            return itemIds;
        \`,
        mapScript: \`
            const itemId = context.currentItemId;
            const minBytes = context.parameters.minFileSizeMB * 1024 * 1024;

            // 1. Fetch item data, including BinaryContent for FileSize
            const item = await context.tools.getItem({ 
                itemId: itemId,
                includeProperties: ["Title", "ComponentType", "BinaryContent.Size"]
            });

            // 2. Filter for large Multimedia Components
            if (!item || item.ComponentType !== 'Multimedia' || !item.BinaryContent) {
                return null; // Not a multimedia component
            }
            if (item.BinaryContent.Size < minBytes) {
                return null; // Too small
            }
            context.log(\`Found large file: \${item.Title} (\${item.BinaryContent.Size} bytes)\`);

            // 3. Find all Pages that use this component
            const graph = await context.tools.dependencyGraphForItem({
                itemId: itemId,
                direction: "UsedBy",
                rloItemTypes: ["Page"], // Only care about Page usages
                details: "IdAndTitle"
            });

            // Helper to flatten the graph into a list of Page IDs
            function flattenPageIds(node) {
                let ids = [];
                if (!node || !node.Dependencies) return ids;
                for (const child of node.Dependencies) {
                    if (child.Item && child.Item.type === 'Page') {
                        ids.push(child.Item.Id);
                    }
                    ids = ids.concat(flattenPageIds(child));
                }
                return [...new Set(ids)]; // Return unique IDs
            }
            
            const pageIds = flattenPageIds(graph);
            if (pageIds.length === 0) {
                context.log('  -> Unused by any Page. Adding to report.');
                return { id: item.Id, title: item.Title, size: item.BinaryContent.Size, reason: "Unused by any Page" };
            }
            context.log(\`  -> Used by \${pageIds.length} Page(s). Checking if any are published...\`);

            // 4. Check if ANY of the using Pages are published
            for (const pageId of pageIds) {
                const publishInfo = await context.tools.getPublishInfo({ 
                    itemId: pageId, 
                    includeProperties: ["PublishedAt"] 
                });
                
                if (publishInfo && publishInfo.length > 0) {
                    // This component is used by at least one published page. It's safe.
                    context.log(\`  -> Used by published Page \${pageId}. Skipping.\`);
                    return null;
                }
            }
            
            // 5. If loop finishes, it's used, but only by UNPUBLISHED pages
            context.log('  -> Used only by UNPUBLISHED pages. Adding to report.');
            return { id: item.Id, title: item.Title, size: item.BinaryContent.Size, reason: "Used only by unpublished Pages" };
        \`,
        postProcessingScript: \`
            // Phase 3 (Reduce): Collect all items to delete
            context.log('Aggregating report...');
            const itemsToReport = context.successes
                .filter(r => r.result !== null)
                .map(r => r.result);

            return {
                totalChecked: context.results.length,
                totalFilesToReview: itemsToReport.length,
                filesToReview: itemsToReport
            };
        \`
    });

Example 12: Robust Relational Import (e.g., Articles & Pages)
This example shows the recommended multi-stage pattern to import relational data (e.g., from an Excel file) while avoiding timeouts and race conditions.
This pattern uses *two sequential 'toolOrchestrator' calls*:
1.  Call 1 (Create Dependencies): Creates all the unique 'Article' components in parallel.
2.  Call 2 (Create Consumers): Creates all the 'Pages' in parallel, safely linking to the components created in Call 1.

// --- Call 1: Create all prerequisite items AND all unique Article Components ---
// (This first call assumes schemas, folders, etc., are created in the preProcessingScript,
// as shown in the previous agent attempts. For brevity, this example focuses on
// creating components from a pre-defined 'articlesSheet'.)

const result1 = await tools.toolOrchestrator({
    parameters: {
        // This 'prerequisites' object would be the result of a *previous* setup step
        // or could be constructed by reading the Excel file in the preProcessingScript.
        "prerequisites": {
            "articleSchemaId": "tcm:5-3574-8",
            "componentsFolderId": "tcm:5-637-2",
            "tagNameKeywordIdMap": { "AI": "tcm:5-3532-1024", /* ... */ },
            "articlesSheet": [ { "uniqueKey": "ai-001", "headline": "The Future of AI", "bodyText": "...", "tags": "AI;Future" } /*, ... */ ],
            "authorsSheet": [ { "articleKey": "ai-001", "firstName": "Jane" } /*, ... */ ],
            "pageMapSheet": [ { "pageTitle": "Home", "articleKey": "ai-001" } /*, ... */ ],
            "presentationTypeToTemplateIdMap": { "Hero": "tcm:5-3576-32" /*, ... */ },
            "pageTemplateId": "tcm:5-3581-128",
            "structureGroupId": "tcm:5-638-4"
        }
    },
    // 'preProcessingScript' just reads the data and passes the *article keys* as itemIds
    preProcessingScript: \`
        context.log("Phase 1: Starting Article Component creation...");
        const articles = context.parameters.prerequisites.articlesSheet;
        if (!articles) throw new Error("articlesSheet is missing from parameters.");
        
        // Return one 'itemId' for each article to be created
        return {
            itemIds: articles.map(a => a.uniqueKey),
            preProcessingResult: {
                // Pass all data through to the map/post scripts
                ...context.parameters.prerequisites
            }
        };
    \`,
    // 'mapScript' creates ONE component. This can run with high concurrency.
    mapScript: \`
        const articleKey = context.currentItemId;
        context.log(\`Creating component for article: \${articleKey}\`);

        const { 
            articlesSheet, authorsSheet,
            articleSchemaId, componentsFolderId, tagNameKeywordIdMap
        } = context.preProcessingResult;

        const article = articlesSheet.find(a => a.uniqueKey === articleKey);
        if (!article) throw new Error(\`Article data for \${articleKey} not found.\`);

        const authorsForArticle = authorsSheet
            .filter(a => a.articleKey === article.uniqueKey)
            .map(a => ({ firstName: a.firstName, lastName: a.lastName, bio: a.bio }));
        
        const tagsForArticle = article.tags.split(';')
            .map(tagName => ({ "type": "Link", "IdRef": tagNameKeywordIdMap[tagName] }))
            .filter(tag => tag.IdRef);

        const component = await context.tools.createComponent({
            title: article.headline,
            locationId: componentsFolderId,
            schemaId: articleSchemaId,
            content: {
                "headline": article.headline,
                "body": \`<p>\${article.bodyText}</p>\`,
                "authors": authorsForArticle,
                "tags": tagsForArticle
            }
        });

        // Return a key-value pair for the post-script
        return {
            key: articleKey,
            id: component.Id,
            title: component.Title
        };
    \`,
    // 'postProcessingScript' collects the results into a map for the next stage
    postProcessingScript: \`
        context.log("Phase 1 Complete: Aggregating created components...");
        
        // Convert the array of {key, id} objects into a simple Map
        const articleKeyToComponentIdMap = new Map(
            context.successes.map(s => [s.result.key, s.result.id])
        );

        // Return all the data needed for the *next* tool call
        return {
            summary: \`Created \${context.successes.length} components.\`,
            articleKeyToComponentIdMap: Object.fromEntries(articleKeyToComponentIdMap),
            
            // Pass the other prerequisite data along
            pageMapSheet: context.preProcessingResult.pageMapSheet,
            presentationTypeToTemplateIdMap: context.preProcessingResult.presentationTypeToTemplateIdMap,
            pageTemplateId: context.preProcessingResult.pageTemplateId,
            structureGroupId: context.preProcessingResult.structureGroupId
        };
    \`
});

// --- Call 2: Create all Pages in Parallel ---
// 'result1' holds the output from the first call.
// We parse its JSON and pass it as a parameter to the second call.
const pageCreationParams = JSON.parse(result1.content[0].text);

const result2 = await tools.toolOrchestrator({
    parameters: {
        "pageCreationParams": pageCreationParams
    },
    // Use 'preProcessingScript' to find all *unique page titles*
    preProcessingScript: \`
        context.log("Phase 2: Starting Page creation...");
        const pageMap = context.parameters.pageCreationParams.pageMapSheet;
        const uniquePageTitles = [...new Set(pageMap.map(p => p.pageTitle))];
        context.log(\`Found \${uniquePageTitles.length} unique pages to create.\`);
        
        return {
            itemIds: uniquePageTitles,
            preProcessingResult: context.parameters.pageCreationParams
        };
    \`,
    // 'mapScript' creates ONE page. This is now safe to run in parallel.
    mapScript: \`
        const pageTitle = context.currentItemId;
        context.log(\`Assembling page: \${pageTitle}\`);
        
        const {
            pageMapSheet,
            articleKeyToComponentIdMap,
            presentationTypeToTemplateIdMap,
            pageTemplateId,
            structureGroupId
        } = context.preProcessingResult;

        // Find all rows in the Excel sheet for this specific page
        const pageEntries = pageMapSheet.filter(row => row.pageTitle === pageTitle);
        if (pageEntries.length === 0) throw new Error(\`No data for page \${pageTitle}\`);
        
        const fileName = pageEntries[0].fileName;
        const regions = {};

        // Assemble all component presentations for this page
        for (const entry of pageEntries) {
            const regionName = entry.regionName;
            if (!regions[regionName]) regions[regionName] = [];

            // SAFELY LOOKUP the component ID (no race condition)
            const componentId = articleKeyToComponentIdMap[entry.articleKey];
            const templateId = presentationTypeToTemplateIdMap[entry.presentationType];

            if (!componentId) {
                context.log(\`WARN: Skipping component '\${entry.articleKey}' (ID not found).\`);
                continue;
            }

            regions[regionName].push({
                "type": "ComponentPresentation",
                "Component": { "type": "Link", "IdRef": componentId },
                "ComponentTemplate": { "type": "Link", "IdRef": templateId }
            });
        }

        const regionsForPage = Object.keys(regions).map(regionName => ({
            "type": "EmbeddedRegion",
            "RegionName": regionName,
            "ComponentPresentations": regions[regionName]
        }));

        // Create the page
        const page = await context.tools.createPage({
            title: pageTitle,
            locationId: structureGroupId,
            fileName: fileName,
            pageTemplateId: pageTemplateId,
            regions: JSON.stringify(regionsForPage)
        });

        return { id: page.Id, title: page.Title };
    \`,
    // 'postProcessingScript' provides the final summary
    postProcessingScript: \`
        context.log("Phase 2 Complete: Summarizing page creation.");
        return {
            message: \`Successfully created \${context.successes.length} pages.\`,
            createdPages: context.successes.map(s => s.result),
            errors: context.failures.map(f => ({ page: f.itemId, error: f.error }))
        };
    \`
});

Example 13: Advanced Debugging with \`try...catch\`
This script shows how to safely test logic. It finds items, but one (tcm:5-9999) is intentionally non-existent.
It uses \`stopOnError: false\` and a \`try...catch\` block to handle the expected failure gracefully.
This script would first be run by following the "Debugging Strategies" (test on one item), then run on the full list.

    const result = await tools.toolOrchestrator({
        itemIds: ["tcm:5-100", "tcm:5-9999", "tcm:5-101"], // tcm:5-9999 does not exist
        parameters: { "newValue": "New Value" },
        // --- DEBUGGING SETUP ---
        stopOnError: false,     // <-- 1. Continue if one item fails
        maxConcurrency: 1,      // <-- 2. Make log sequential
        debug: true,            // <-- 3. Get the full log
        // ---
        mapScript: \`
            const itemId = context.currentItemId;
            context.log(\`Processing \${itemId}...\`);
            let item;

            // 1. ADVANCED: Use try...catch to handle tool errors
            try {
                item = await context.tools.getItem({ 
                    itemId: itemId,
                    includeProperties: ["Content.TextField"]
                });
                
                if (!item) {
                    // This case handles items that are findable but inaccessible
                    context.log("Item was null or inaccessible.");
                    // Return a custom error object for the post-script
                    return { error: "Item was null or inaccessible" };
                }

            } catch (e) {
                // This 'catch' block will handle errors from the tool itself
                // e.g., "Item tcm:5-9999 not found."
                context.log(\`Failed to get item: \${e.message}\`);
                // Return a custom error object
                return { error: e.message };
            }

            // 2. Logic: If we are here, 'item' is valid
            context.log(\`Got item: \${item.Title}. Checking content...\`);
            let content = item.Content;
            
            if (content && content.TextField) {
                content.TextField = context.parameters.newValue;
                
                // 3. Update
                await context.tools.updateContent({
                    itemId: itemId,
                    content: content
                });
                
                context.log("Update logic complete.");
                // Return a success object
                return { updated: true, title: item.Title };
                
            } else {
                context.log("No 'TextField' found to update.");
                // Return a "skipped" object
                return { updated: false, title: item.Title, reason: "No TextField" };
            }
        \`,
        postProcessingScript: \`
            // Phase 3: We can now report on our custom return objects
            context.log("Aggregating custom results...");

            // We must now check 'r.result.error'
            const mySuccesses = context.successes
                .filter(r => r.result && !r.result.error)
                .map(r => r.result);
                
            // Combine failures from the orchestrator (status: 'error')
            // with our own *handled* errors (status: 'success', result: {error: ...})
            const myFailures = context.results
                .filter(r => r.status === 'error' || (r.result && r.result.error))
                .map(r => ({
                    itemId: r.itemId,
                    error: r.result?.error || r.error
                }));

            return {
                message: "Batch complete. See report.",
                itemsUpdated: mySuccesses.filter(r => r.updated).length,
                itemsSkipped: mySuccesses.filter(r => !r.updated).length,
                itemsFailed: myFailures.length,
                failures: myFailures
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
        formatForApi(input);
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
        if (finalItemIds.length > 0 && mapScript) {
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

                const perItemLog = (message: string) => logs.push(`[${itemId}] ${message}`);
                const perItemErrorLog = (message: string) => logs.push(`[${itemId}] [ERROR] ${message}`);
                const perItemWarnLog = (message: string) => logs.push(`[${itemId}] [WARN] ${message}`);

                const perItemContext: MapScriptContext = {
                    currentItemId: itemId,
                    parameters: Object.freeze(parameters),
                    preProcessingResult: preScriptContextData,
                    tools: toolWrappers,
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
                    results.push({
                        itemId: itemId,
                        status: "success",
                        result: (result === undefined) ? "No return value" : result
                    });
                    logs.push(`[${itemId}] Success.`);

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
            if (finalItemIds.length > 0 && !mapScript) {
                log("Items found but no mapScript provided. Skipping map phase.");
            } else {
                log("No items found to process. Skipping map phase.");
            }
        }
        // --- End of Map Phase ---


        // --- Phase 3: Post-Processing Logic (Reduce Phase) ---
        if (postProcessingScript) {
            logs.push("\nStarting post-processing script (reduce phase)...");

            // Pre-filter results for the post-script
            const successes = results.filter(r => r.status === 'success');
            const failures = results.filter(r => r.status === 'error');

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
                failures: Object.freeze(failures),
                parameters: Object.freeze(parameters),
                preProcessingResult: preScriptContextData,
                tools: toolWrappers,
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

                let responsePayload: any = finalResult;

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
                    responsePayload = {
                        result: finalResult,
                        executionLog: logOutput.join('\n')
                    };
                }

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(responsePayload, null, 2)
                    }],
                };

            } catch (error: any) {
                const errorMessage = extractErrorMessage(error);
                logs.push(`Post-Processing Script FAILED: ${errorMessage}`);

                const successCount = successes.length;
                const errorCount = failures.length;

                // Create a small, safe JSON error object.
                const finalErrorSummary = {
                    summary: "ToolOrchestrator FAILED",
                    phase: "post-processing",
                    mapPhaseSummary: {
                        totalItemsProcessed: results.length,
                        succeeded: successCount,
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
        }

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
            // Truncate the log to the first 25 and last 25 lines
            let logOutput = logs;
            if (logs.length > 50) {
                logOutput = [
                    ...logs.slice(0, 25),
                    `\n... (log truncated - ${logs.length - 50} lines hidden) ...\n`,
                    ...logs.slice(-25)
                ];
            }
            summaryObject.executionLog = logOutput.join('\n');
        }
        return {
            content: [{
                type: "text",
                text: JSON.stringify(summaryObject, null, 2)
            }],
        };
    }
};
import { z } from "zod";

// Define the shape of the context object that the agent's script will receive.
interface ScriptContext {
    /** The TCM URI of the item currently being processed in the loop. */
    currentItemId: string;
    /** The JSON object passed to the 'parameters' input of the scriptRunner tool. */
    parameters: Record<string, any>;
    /** A dictionary of all available tools, wrapped for execution (e.g., `tools.getItem`, `tools.updateContent`). */
    tools: { [toolName: string]: (args: any) => Promise<any> };
    /** The original MCP context, containing session IDs, etc. (for advanced use). */
    mcpContext: any;
    /** A function to log messages, which will be included in the final summary. */
    log: (message: string) => void;
}

// This plain object defines the input properties, matching your other tools
const scriptRunnerInputProperties = {
    itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/))
        .min(1, "At least one item ID must be provided.")
        .describe("An array of unique IDs (TCM URIs) for the items to be processed."),
    script: z.string()
        .describe("A JavaScript string (as an async function body) to execute for each item. The script has access to a 'context' object."),
    parameters: z.record(z.any()).optional()
        .describe("An optional JSON object of parameters to pass into the script. Use this for static values like find/replace strings (e.g., {'find': 'old text', 'replace': 'new text'})."),
    stopOnError: z.boolean().optional().default(true)
        .describe("If true (default), the entire operation stops if any single item fails. If false, it logs the error and continues to the next item."),
    maxConcurrency: z.number().int().min(1).max(10).optional().default(5)
        .describe("The maximum number of scripts to run in parallel. Set to 1 for sequential execution (e.g., for script validation and debugging, or if the server is under heavy load).")
};

// This Zod object is now used internally for type inference, but not exported
const scriptRunnerSchema = z.object(scriptRunnerInputProperties);

export const scriptRunner = {
    name: "scriptRunner",
    description: `Executes an advanced, multi-step JavaScript script for each item in a provided list. 
    By default, up to 5 scripts can run in parallel. Setting a higher 'maxConcurrency' value can increase speed at the cost of overall server load. Only use a value of 1 when debugging a script or when explicitly requested by the user.
    
The script receives a 'context' object with the following properties:
- context.currentItemId (string): The ID of the item currently being processed.
- context.parameters (object): The JSON object you passed to the 'parameters' input.
- context.tools (object): A dictionary of all available tools (e.g., context.tools.getItem, context.tools.updateContent).
- context.log(message) (function): A function to log progress to the final summary.
        
The script *must* be 'async' and can 'await' tool calls. All tool calls (e.g., 'await context.tools.getItem({ itemId: context.currentItemId })') are automatically authenticated.
All tools return a standard object, typically \`{ content: [{ type: "text", text: "..." }] }\`.
For tools that return data (like 'getItem'), the 'text' field will contain a JSON string that you must parse.

To use the AI, call the 'generateContentFromPrompt' tool:
const aiResult = await context.tools.generateContentFromPrompt({ prompt: '...' });
const generatedText = aiResult.content[0].text;

Examples:

Example 1: Find and Replace in a Component Field
This script finds 'Old Product Name' and replaces it with 'New Product Name' in the 'TextField' of several components. It runs up to 10 in parallel.

    const result = await tools.scriptRunner({
        itemIds: ["tcm:5-100", "tcm:5-101", "tcm:5-102"],
        parameters: {
            "find": "Old Product Name",
            "replace": "New Product Name"
        },
        maxConcurrency: 10,
        script: \`
            // Get the item's content
            const itemResult = await context.tools.getItem({ 
                itemId: context.currentItemId,
                includeProperties: ["Content.TextField"]
            });
            // All tools return a { content: [...] } object with a JSON string.
            const item = JSON.parse(itemResult.content[0].text);

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

Example 2: AI-Driven Content Rewrite
This script uses the AI to rewrite the 'Summary' field of several articles to have a 'professional' tone. It runs sequentially (maxConcurrency: 1).

    const result = await tools.scriptRunner({
        itemIds: ["tcm:5-200", "tcm:5-201"],
        parameters: {
            "tone": "professional and engaging"
        },
        maxConcurrency: 1,
        script: \`
            // Get the item's content
            const itemResult = await context.tools.getItem({ 
                itemId: context.currentItemId,
                includeProperties: ["Content.Summary"]
            });
            const item = JSON.parse(itemResult.content[0].text);
            
            const originalSummary = item.Content ? item.Content.Summary : null;
            if (!originalSummary) {
                context.log('Item has no Content or Summary field. Skipping.');
                return;
            }
            context.log(\`Original summary: \${originalSummary.substring(0, 50)}...\`);

            // Use AI to rewrite the summary
            const aiPrompt = \`Rewrite the following summary to have a \${context.parameters.tone} tone:\\n\\n\${originalSummary}\`;
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
`,

    // The 'input' property is now the plain object
    input: scriptRunnerInputProperties,

    execute: async (
        // Type inference for 'input' now uses the internal schema
        input: z.infer<typeof scriptRunnerSchema>,
        mcpContext: any
    ) => {
        const { itemIds, script, parameters = {}, stopOnError, maxConcurrency } = input;

        if (!mcpContext.tools || typeof mcpContext.tools !== 'object') {
            return {
                content: [{ type: "text", text: "Error: Tool execution context is missing. 'scriptRunner' cannot access other tools." }]
            };
        }

        // Create the sandboxed async function from the agent's script string.
        let scriptFunction: (context: ScriptContext) => Promise<any>;
        try {
            scriptFunction = new Function('context', `
                return (async (context) => {
                    "use strict";
                    ${script}
                })(context);
            `) as (context: ScriptContext) => Promise<any>;
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Script Compilation Error: ${error.message}` }]
            };
        }

        const results: any[] = [];
        const logs: string[] = [];
        const log = (message: string) => logs.push(message);

        log(`Starting scriptRunner for ${itemIds.length} items with maxConcurrency: ${maxConcurrency}`);

        const toolWrappers: { [toolName: string]: (args: any) => Promise<any> } = {};
        for (const toolName in mcpContext.tools) {
            const originalToolExecute = mcpContext.tools[toolName].execute;
            toolWrappers[toolName] = (args: any) => {
                return originalToolExecute(args, mcpContext);
            };
        }

        let hasFailed = false;

        /**
         * A single, reusable function to run the script for one item
         * and handle logging, results, and errors.
         */
        const runTask = async (itemId: string, index: number): Promise<void> => {
            logs.push(`\n[${index + 1}/${itemIds.length}] Processing item: ${itemId}`);
            
            const perItemContext: ScriptContext = {
                currentItemId: itemId,
                parameters: parameters,
                tools: toolWrappers,
                mcpContext: mcpContext,
                log: (message: string) => logs.push(`[${itemId}] ${message}`)
            };

            try {
                const result = await scriptFunction(perItemContext);
                results.push({ itemId: itemId, status: "success", result: result || "No return value" });
                logs.push(`[${itemId}] Success.`);

            } catch (error: any) {
                let errorMessage: string;
                if (error && error.content && Array.isArray(error.content) && error.content[0]?.type === 'text') {
                    // This was a "clean" error returned by a tool
                    errorMessage = error.content[0].text;
                } else if (error instanceof Error) {
                    // This was a standard script error (e.g., SyntaxError, TypeError)
                    errorMessage = `${error.name}: ${error.message}`;
                } else {
                    // Fallback for other error types
                    errorMessage = String(error);
                }
                
                logs.push(`[${itemId}] FAILED: ${errorMessage}`);
                results.push({ itemId: itemId, status: "error", error: errorMessage });
                hasFailed = true;
            }
        };

        // --- Execution Logic ---
        if (maxConcurrency === 1) {
            log("Running in sequential mode.");
            for (const [index, itemId] of itemIds.entries()) {
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
            
            for (const itemId of itemIds) {
                if (stopOnError && hasFailed) {
                    logs.push("\nOperation stopping due to error. No new tasks will be started.");
                    break;
                }
                
                // Wait for any promise in the set to finish if the pool is full
                while (workerPool.size >= maxConcurrency) {
                    await Promise.race(workerPool);
                }
                
                const taskPromise = runTask(itemId, index++);
                
                // Wrapper to remove the promise from the pool on completion
                const onFinally = () => {
                    workerPool.delete(taskPromise);
                };
                
                taskPromise.then(onFinally, onFinally); // Remove from pool on success or failure
                workerPool.add(taskPromise);
            }
            
            // Wait for all remaining tasks in the pool to finish
            await Promise.allSettled(Array.from(workerPool));
        }
        // --- End of Execution Logic ---

        logs.push("\nscriptRunner finished.");
        const successCount = results.filter(r => r.status === 'success').length;
        const errorCount = results.filter(r => r.status === 'error').length;

        let summary = `ScriptRunner Summary:
- Total items: ${itemIds.length}
- Succeeded: ${successCount}
- Failed: ${errorCount}

--- Execution Log ---
${logs.join('\n')}
`;
        
        if (errorCount > 0) {
            const errorDetails = results
                .filter(r => r.status === 'error')
                .map(r => ({ itemId: r.itemId, error: r.error }));
            summary += "\n--- Error Details ---\n";
            summary += JSON.stringify(errorDetails, null, 2);
        }

        return {
            content: [{
                type: "text",
                text: summary
            }],
        };
    }
};
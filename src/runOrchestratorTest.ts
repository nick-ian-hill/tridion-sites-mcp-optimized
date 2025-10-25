import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// --- Tool Interface (Copied from index.ts) ---
interface Tool {
    name: string;
    description: string;
    input: any;
    execute: Function;
}

function isTool(obj: any): obj is Tool {
    return (
        obj &&
        typeof obj === 'object' &&
        'name' in obj && typeof obj.name === 'string' &&
        'description' in obj && typeof obj.description === 'string' &&
        'input' in obj &&
        'execute' in obj && typeof obj.execute === 'function'
    );
}
// ---------------------------------------------


/**
 * This function loads all tools from the /tools directory,
 * exactly like index.ts, and then executes the toolOrchestrator
 * with a specific test script.
 */
async function runTest() {
    console.log("--- Starting Orchestrator Integration Test ---");

    // --- 1. Load All Tools (Logic from index.ts) ---
    console.log("Loading all tools from '/tools' directory...");
    const tools: Tool[] = [];
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const toolsDirPath = path.join(__dirname, 'tools');

    try {
        const toolFiles = await fs.readdir(toolsDirPath);
        for (const file of toolFiles) {
            if (file.endsWith('.ts')) {
                const modulePath = path.join(toolsDirPath, file);
                const moduleUrl = pathToFileURL(modulePath).href;
                const module = await import(moduleUrl);
                const potentialTool = Object.values(module)[0];

                if (isTool(potentialTool)) {
                    tools.push(potentialTool);
                }
            }
        }
    } catch (error) {
        console.error("----- FATAL: Could not load tools -----");
        console.error(error);
        process.exit(1);
    }
    
    console.log(`Successfully loaded ${tools.length} tools.`);

    // --- 2. Build the exact Context and find the Orchestrator ---
    const toolsAsRecord: Record<string, Tool> = tools.reduce((acc, tool) => {
        acc[tool.name] = tool;
        return acc;
    }, {} as Record<string, Tool>);

    const orchestratorTool = tools.find(t => t.name === 'toolOrchestrator');

    if (!orchestratorTool) {
        console.error("----- FATAL: toolOrchestrator was not found in the /tools directory -----");
        process.exit(1);
    }
    
    // This is the identical context the server would create
    const mcpContext = {
        tools: toolsAsRecord
    };

    // --- 3. Define Your Test Case ---
    // This is the "Modified Pages Report" test script.
    
    const testInput = {
        debug: true,
        maxConcurrency: 1, // Keep at 1 for clearer test logs
        
        itemIds: ["tcm:5-1784-64"],
        mapScript: `
            // This is the FULL, correct script
            context.log('Checking: ' + context.currentItemId);
            const item = await context.tools.getItem({ 
                itemId: context.currentItemId,
                includeProperties: ["VersionInfo.RevisionDate", "Title"]
            });

            if (!item || !item.VersionInfo) {
                context.log("Item not found or lacks VersionInfo. Skipping.");
                return null;
            }
            const revisionDate = new Date(item.VersionInfo.RevisionDate);
            context.log('  Item Title: ' + item.Title);
            context.log('  Item RevisionDate: ' + revisionDate.toISOString());

            const publishInfos = await context.tools.getPublishInfo({ 
                itemId: context.currentItemId,
                includeProperties: ["PublishedAt", "TargetType.Title"] 
            });

            if (!publishInfos || publishInfos.length === 0) {
                context.log("  No publish info found. Skipping.");
                return null;
            }

            const modifiedOnTargets = [];
            for (const info of publishInfos) {
                if (info && info.PublishedAt && info.TargetType && info.TargetType.Title) {
                    const publishedAt = new Date(info.PublishedAt);
                    context.log('  -> Target: "' + info.TargetType.Title + '", Published: ' + publishedAt.toISOString());
                    if (revisionDate > publishedAt) {
                        context.log('     Comparison: TRUE (Modified)');
                        modifiedOnTargets.push(info.TargetType.Title);
                    } else {
                        context.log('     Comparison: FALSE (Not Modified)');
                    }
                }
            }
            
            if (modifiedOnTargets.length > 0) {
                return {
                    id: context.currentItemId,
                    title: item.Title,
                    staleOnTargets: [...new Set(modifiedOnTargets)]
                };
            }
            return null; // Not modified on any target
        `,
        postProcessingScript: `
            context.log('TEST RUN: Aggregating ' + results.length + ' results.');
            const modifiedItems = results
                .filter(r => r.status === 'success' && r.result !== null)
                .map(r => r.result);

            return {
                totalChecked: results.length,
                totalModified: modifiedItems.length,
                pagesWithStaleTargets: modifiedItems
            };
        `
    };
    
    // --- 4. Execute the Test ---
    console.log("\n--- Executing toolOrchestrator with test script ---");
    
    try {
        // We cast to 'any' to bypass schema checking for this test harness
        const result = await orchestratorTool.execute(testInput as any, mcpContext);
        
        console.log("\n--- toolOrchestrator Final Output ---");
        // The orchestrator's logs will have already appeared in your terminal
        // This prints the final JSON payload.
        const output = JSON.parse(result.content[0].text);
        console.log(JSON.stringify(output, null, 2));

    } catch (error) {
        console.error("\n--- toolOrchestrator FAILED ---");
        console.error(error);
    }
    console.log("\n--- Test Finished ---");
}

// Run the test
runTest();
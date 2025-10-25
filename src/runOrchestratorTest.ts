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
    // This script now uses the 'dependencyGraphForItem' tool for a
    // complete and accurate check of all dependencies.
    
    const testInput = {
        debug: true,
        maxConcurrency: 1, // Keep at 1 for clearer test logs
        
        preProcessingScript: `
            context.log('TEST RUN: Finding ALL pages in Publication tcm:0-5-1...');
            
            const allItems = await context.tools.getItemsInContainer({
                containerId: "tcm:0-5-1", // The root of the Publication
                itemTypes: ["Page"],
                recursive: true,
                details: "IdAndTitle"
            });

            const itemIds = allItems.map(item => item.Id);
            context.log('Found ' + itemIds.length + ' total Pages to check.');
            return itemIds;
        `,
        mapScript: `
            context.log('Checking Page: ' + context.currentItemId);
            
            // 1. Get Page's own info
            const item = await context.tools.getItem({ 
                itemId: context.currentItemId,
                includeProperties: ["Title", "VersionInfo.RevisionDate"]
            });

            if (!item || !item.VersionInfo) {
                context.log("Page not found or lacks VersionInfo. Skipping.");
                return null;
            }
            context.log('  Page Title: ' + item.Title);

            // 2. Get Publish info for the Page
            const publishInfos = await context.tools.getPublishInfo({ 
                itemId: context.currentItemId,
                includeProperties: ["PublishedAt", "TargetType.Title"] 
            });

            if (!publishInfos || publishInfos.length === 0) {
                context.log("  No publish info found. Skipping page.");
                return null; // Page has never been published
            }

            // 3. Get *all* Component dependencies (direct and indirect)
            context.log('  Fetching dependency graph for components...');
            
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

            let dependencyDetails = []; // This will hold our component items
            try {
                // --- FIX: Inside the orchestrator, tool calls return the final JSON *directly*,
                // not the { content: [...] } wrapper.
                const graph = await context.tools.dependencyGraphForItem({
                    itemId: context.currentItemId,
                    direction: "Uses", // Get items this page *uses*
                    rloItemTypes: ["Component"], // Only find Components
                    includeProperties: ["Title", "VersionInfo.RevisionDate"] // Get details we need
                });
                
                // Now, 'graph' is the DependencyGraphNode object, not a 'response' object
                if (graph && graph.Dependencies) {
                    dependencyDetails = flattenDependencies(graph);
                    context.log('  Found ' + dependencyDetails.length + ' total Component dependencies.');
                } else {
                    context.log('  Tool returned an invalid graph object. Assuming 0 dependencies.');
                    dependencyDetails = [];
                    context.log('  Found 0 total Component dependencies.');
                }
                // --- END FIX ---
                
            } catch (e) {
                context.log('  ERROR: Failed to get dependency graph: ' + e.message);
                return null;
            }


            // 4. Find the single LATEST modification date from the page + all dependencies
            let latestModificationDate = new Date(item.VersionInfo.RevisionDate);
            let latestModifiedItem = { 
                title: item.Title + ' (Page)', 
                date: latestModificationDate 
            };

            for (const comp of dependencyDetails) {
                if (comp && comp.VersionInfo && comp.VersionInfo.RevisionDate) {
                    const compRevisionDate = new Date(comp.VersionInfo.RevisionDate);
                    if (compRevisionDate > latestModificationDate) {
                        latestModificationDate = compRevisionDate;
                        latestModifiedItem = { 
                            title: comp.Title + ' (' + comp.Id + ')', 
                            date: latestModificationDate 
                        };
                    }
                }
            }
            context.log('  Latest modification: ' + latestModificationDate.toISOString() + ' from "' + latestModifiedItem.title + '"');
            
            // 5. Loop through each target and do one simple comparison
            const staleOnTargets = {};
            for (const info of publishInfos) {
                if (!info || !info.PublishedAt || !info.TargetType || !info.TargetType.Title) {
                    continue;
                }
                
                const targetName = info.TargetType.Title;
                const publishedAt = new Date(info.PublishedAt);
                context.log('  -> Checking Target: "' + targetName + '", Published: ' + publishedAt.toISOString());

                if (latestModificationDate > publishedAt) {
                    context.log('     Comparison: TRUE (Stale)');
                    staleOnTargets[targetName] = {
                        reason: 'Content modified',
                        staleItem: latestModifiedItem.title,
                        modifiedDate: latestModifiedItem.date.toISOString(),
                        publishedDate: publishedAt.toISOString()
                    };
                } else {
                    context.log('     Comparison: FALSE (Up to date)');
                }
            }
            
            // 6. Return a result ONLY if any target was found to be stale
            if (Object.keys(staleOnTargets).length > 0) {
                return {
                    id: context.currentItemId,
                    title: item.Title,
                    staleTargets: staleOnTargets
                };
            }
            
            return null; // Not stale on any target
        `,
        postProcessingScript: `
            context.log('TEST RUN: Aggregating ' + results.length + ' results.');
            const modifiedItems = results
                .filter(r => r.status === 'success' && r.result !== null)
                .map(r => r.result);

            return {
                totalChecked: results.length,
                totalStalePages: modifiedItems.length,
                stalePages: modifiedItems
            };
        `
    };
    
    // --- 4. Execute the Test ---
    console.log("\n--- Executing toolOrchestrator with test script ---");
    
    try {
        // We cast to 'any' to bypass schema checking for this test harness
        const result = await orchestratorTool.execute(testInput as any, mcpContext);
        
        console.log("\n--- toolOrchestrator Final Output ---");
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
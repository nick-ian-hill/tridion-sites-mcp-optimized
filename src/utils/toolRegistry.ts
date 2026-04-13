import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface Tool {
    name: string;
    summary: string;
    description: string;
    examples: any[];
    input: any;
    execute: (args: any, context: any) => Promise<any>;
}

export function isTool(obj: any): obj is Tool {
    return (
        obj &&
        typeof obj === 'object' &&
        'name' in obj && typeof obj.name === 'string' &&
        'summary' in obj && typeof obj.summary === 'string' &&
        'description' in obj && typeof obj.description === 'string' &&
        'examples' in obj && Array.isArray(obj.examples) &&
        'input' in obj &&
        'execute' in obj && typeof obj.execute === 'function'
    );
}

let toolRegistry: Map<string, Tool> = new Map();

/**
 * Initializes the tool registry by dynamically loading tools from the tools/ directory
 * and combining them with manually provided tools.
 */
export async function initializeToolRegistry(manualTools: Tool[] = []): Promise<Map<string, Tool>> {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const toolsDirPath = path.resolve(__dirname, '..', 'tools');

    const loadedToolsMap = new Map<string, Tool>();

    // 1. Manually add tools (like UI assistant tools)
    for (const tool of manualTools) {
        if (isTool(tool)) {
            loadedToolsMap.set(tool.name, tool);
        }
    }

    // 2. Dynamically load standard tools from the tools/ directory
    try {
        const toolFiles = await fs.readdir(toolsDirPath);
        for (const file of toolFiles) {
            if (file.endsWith('.ts') || file.endsWith('.js')) {
                // Skip files that aren't tool definitions if any exist (though currently they all seem to be tools)
                const modulePath = path.join(toolsDirPath, file);
                const moduleUrl = pathToFileURL(modulePath).href;
                const module = await import(moduleUrl);

                // Most tools export the tool object as the only value or as a named export
                // We'll look for the first valid tool object in the module exports
                const potentialTool = Object.values(module).find(isTool);

                if (potentialTool) {
                    if (!loadedToolsMap.has(potentialTool.name)) {
                        loadedToolsMap.set(potentialTool.name, potentialTool);
                    }
                } else {
                    console.warn(`Warning: File ${file} does not export a valid tool object.`);
                }
            }
        }
    } catch (error) {
        console.error("Error loading tools for registry:", error);
    }

    toolRegistry = loadedToolsMap;
    console.log(`Successfully loaded ${toolRegistry.size} tools into the registry. These will be exposed via 2 dynamic meta-tools (getToolDetails and callTool).`);
    return toolRegistry;
}

/**
 * Returns the central tool registry.
 */
export function getToolRegistry(): Map<string, Tool> {
    return toolRegistry;
}

function extractSchemaParams(jsonSchema: any, prefix = ''): string[] {
    const params: string[] = [];
    if (jsonSchema && jsonSchema.properties) {
        for (const [key, value] of Object.entries(jsonSchema.properties)) {
            const pName = prefix ? `${prefix}.${key}` : key;
            params.push(pName);
            if (typeof value === "object" && value !== null && (value as any).type === "object" && (value as any).properties) {
                 params.push(...extractSchemaParams(value, pName));
            } else if (typeof value === "object" && value !== null && (value as any).type === "array" && (value as any).items && (value as any).items.type === "object") {
                 params.push(...extractSchemaParams((value as any).items, pName));
            }
        }
    }
    return params;
}

/**
 * Generates a bulleted list of all available tools, extracting the first sentence of each description.
 */
export function getToolsSummary(): string {
    const categories: Record<string, string[]> = {
        "Search & Discovery": ['search', 'getItemsInContainer', 'getItem', 'bulkReadItems', 'getPublications', 'getCategories', 'getSchemaLinks', 'getUsers', 'getMultimediaTypes', 'getApprovalStatuses', 'getProcessDefinitions', 'getLockedItems'],
        "Item Management (CRUD)": ['createItem', 'createComponent', 'createPage', 'updateContent', 'updateMetadata', 'updatePage', 'updateItemProperties', 'deleteItem', 'copyItem', 'moveItem', 'classify'],
        "Schema & System Architecture": ['createComponentSchema', 'createMetadataSchema', 'createEmbeddedSchema', 'createBundleSchema', 'createRegionSchema'],
        "Workflow & Governance": ['checkOutItem', 'checkInItem', 'undoCheckOutItem', 'startWorkflow', 'startActivity', 'forceFinishProcess', 'getPublishTransactions', 'getPublishInfo', 'getItemHistory', 'getUsedByHistory'],
        "BluePrint & Global Hierarchy": ['createPublication', 'updatePublication', 'createBluePrintHierarchy', 'localizeItem', 'unlocalizeItem', 'promoteItem', 'demoteItem', 'getDependencyGraph', 'getRelatedBluePrintItems'],
        "AI & Multimedia Processing": ['autoClassifyItem', 'autoClassifyMultimediaComponent', 'createMultimediaComponentFromPrompt', 'createMultimediaComponentFromAttachment', 'createMultimediaComponentFromBase64', 'createMultimediaComponentFromUrl', 'readMultimediaComponent', 'splitWordMultimediaComponentIntoTextAndImages'],
        "Orchestration & Automation": ['toolOrchestrator', 'readUploadedFile']
    };

    const summary: string[] = [];
    const categorizedSet = new Set<string>();

    for (const [categoryName, toolNames] of Object.entries(categories)) {
        summary.push(`### ${categoryName}`);
        let addedInCategory = false;
        for (const name of toolNames) {
            const tool = toolRegistry.get(name);
            if (tool) {
                const schema = zodToJsonSchema(z.object(tool.input));
                const argsArr = extractSchemaParams(schema as any);
                const argsStr = argsArr.length > 0 ? argsArr.join(', ') : 'no arguments';
                summary.push(`- **${name}** (args: ${argsStr}): ${tool.summary}`);
                categorizedSet.add(name);
                addedInCategory = true;
            }
        }
        if (!addedInCategory) {
            summary.push(`(No tools matched in this category)`);
        }
        summary.push("");
    }

    const uncategorized: string[] = [];
    for (const [name, tool] of toolRegistry.entries()) {
        if (!categorizedSet.has(name)) {
            const schema = zodToJsonSchema(z.object(tool.input));
            const argsArr = extractSchemaParams(schema as any);
            const argsStr = argsArr.length > 0 ? argsArr.join(', ') : 'no arguments';
            uncategorized.push(`- **${name}** (args: ${argsStr}): ${tool.summary}`);
        }
    }

    if (uncategorized.length > 0) {
        summary.push(`### Other Tools`);
        summary.push(...uncategorized);
    }

    return summary.join('\n');
}

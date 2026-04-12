import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface Tool {
    name: string;
    summary: string;
    description: string;
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

/**
 * Generates a bulleted list of all available tools, extracting the first sentence of each description.
 */
export function getToolsSummary(): string {
    const summary: string[] = [];
    for (const [name, tool] of toolRegistry.entries()) {
        summary.push(`- **${name}**: ${tool.summary}`);
    }
    return summary.sort().join('\n');
}

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleStartChat, handlePollChat } from './agent/agent.js';

// --- Direct imports for Assistant-specific tools ---
import { getCurrentTime } from './agent/uiTools/getCurrentTime.js';
import { requestOpenInEditor } from './agent/uiTools/requestOpenInEditor.js';
import { requestNavigation } from './agent/uiTools/requestNavigation.js';

// Set this to false to hide UI-specific tools from the LLM
const ENABLE_UI_ASSISTANT_TOOLS = true;

interface Tool {
    name: string;
    description: string;
    input: any;
    execute: Function;
}

/**
 * A type guard that checks if an object conforms to the Tool interface.
 * @param obj The object to check.
 * @returns True if the object is a valid Tool, otherwise false.
 */
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

async function startServer() {
    const mcpServer = new McpServer({ name: "tridion-sites-mcp-server", version: "1.0.0" });
    const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    const tools: Tool[] = [];

    // 1. Manually register the UI assistant specific tools first
    if (ENABLE_UI_ASSISTANT_TOOLS) {
        if (isTool(getCurrentTime)) {
            tools.push(getCurrentTime);
        }
        if (isTool(requestOpenInEditor)) {
            tools.push(requestOpenInEditor);
        }
        if (isTool(requestNavigation)) {
            tools.push(requestNavigation);
        }
    }

    // 2. Dynamically load standard tools from the tools/ directory
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
                    // Avoid duplicate registration
                    if (!tools.find(t => t.name === potentialTool.name)) {
                        tools.push(potentialTool);
                    }
                } else {
                    console.warn(`Warning: File ${file} does not export a valid tool object.`);
                }
            }
        }

        const toolsAsRecord: Record<string, Tool> = tools.reduce((acc, tool) => {
            acc[tool.name] = tool;
            return acc;
        }, {} as Record<string, Tool>);

        for (const potentialTool of tools) {
            mcpServer.tool(
                potentialTool.name,
                potentialTool.description,
                potentialTool.input,
                (args: any, context: any) => {
                    let finalContext = context;
                    if (potentialTool.name === 'toolOrchestrator') {
                        finalContext = {
                            ...context,
                            tools: toolsAsRecord
                        };
                    }
                    return potentialTool.execute(args, finalContext);
                }
            );
        }

        console.log(`Successfully loaded and registered ${tools.length} tools.`);

    } catch (error) {
        console.error("----- FATAL: Could not load tools -----");
        console.error(error);
        process.exit(1);
    }

    mcpServer.connect(mcpTransport);
    const MCP_API_KEY = process.env.MCP_API_KEY || "demo-secret-key";

    const httpServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8080');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
            res.writeHead(204);
            res.end();
            return;
        }

        // --- NEW: Direct Tool Orchestrator Endpoint ---
        // Allows the UI to execute scripts directly without the LLM Agent wrapper.
        if (req.url === '/agent/tools/orchestrator' && req.method === 'POST') {
            if (req.headers['x-api-key'] !== MCP_API_KEY) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid API Key' }));
                return;
            }

            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const input = JSON.parse(body || '{}');

                    // 1. Re-construct the tools map for this execution context
                    // (We do this here to ensure we have the latest reference to the loaded tools array)
                    const toolsAsRecord = tools.reduce((acc, tool) => {
                        acc[tool.name] = tool;
                        return acc;
                    }, {} as Record<string, Tool>);

                    const orchestratorTool = toolsAsRecord['toolOrchestrator'];

                    if (!orchestratorTool) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: "toolOrchestrator not loaded on server." }));
                        return;
                    }

                    // 2. Manually construct the context expected by toolOrchestrator.ts
                    // The orchestrator expects { tools: ... } in the context to function.
                    const executionContext = {
                        tools: toolsAsRecord
                    };

                    // 3. Execute the tool
                    // This bypasses the McpServer wrapper and calls the underlying tool code directly.
                    const result = await orchestratorTool.execute(input, executionContext);

                    // 4. Unwrap the MCP response format to return clean JSON to the UI.
                    // MCP returns { content: [{ type: 'text', text: 'JSON_STRING' }] }
                    // We want to return just JSON_OBJECT.
                    let cleanResponse = result;
                    if (result && result.content && Array.isArray(result.content) && result.content[0]?.text) {
                        const rawText = result.content[0].text;
                        try {
                            // Check if it looks like JSON before parsing
                            if (typeof rawText === 'string' && (rawText.trim().startsWith('{') || rawText.trim().startsWith('['))) {
                                cleanResponse = JSON.parse(rawText);
                            } else {
                                cleanResponse = { output: rawText };
                            }
                        } catch (e) {
                            // Fallback to raw text if parsing fails
                            cleanResponse = { output: rawText };
                        }
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(cleanResponse));

                } catch (error: any) {
                    console.error("[DirectAPI] Error executing orchestrator:", error);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: "Error",
                        summary: "Script failed to execute",
                        error: error.message || String(error)
                    }));
                }
            });
            return;
        }
        // --- END NEW ENDPOINT ---

        if (req.url === '/agent/chat' && req.method === 'POST') {
            if (req.headers['x-api-key'] !== MCP_API_KEY) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid API Key' }));
                return;
            }
            handleStartChat(req, res, tools);
            return;
        }

        if (req.url === '/agent/poll-updates' && req.method === 'POST') {
            if (req.headers['x-api-key'] !== MCP_API_KEY) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid API Key' }));
                return;
            }
            handlePollChat(req, res);
            return;
        }

        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', () => {
                try {
                    mcpTransport.handleRequest(req, res, JSON.parse(body));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
        } else {
            mcpTransport.handleRequest(req, res);
        }
    });

    httpServer.on('error', (err) => {
        console.error('----- HTTP SERVER ERROR -----');
        console.error(err);
    });

    const port = 8090;
    httpServer.listen(port, () => {
        console.log(`Tridion Sites MCP Server listening on http://localhost:${port}`);
        if (MCP_API_KEY === 'demo-secret-key') {
            console.warn('Warning: Running with a default demo API key. Set the MCP_API_KEY environment variable for production.');
        }
    });
}

startServer();
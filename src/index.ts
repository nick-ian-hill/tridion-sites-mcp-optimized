import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleStartChat, handlePollChat } from './agent/agent.js';

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
                // Handle toolOrchestrator as a special case
                (args: any, context: any) => {
                    let finalContext = context;
                    if (potentialTool.name === 'toolOrchestrator') {
                        finalContext = {
                            ...context,
                            tools: toolsAsRecord
                        };
                    }
                    // All other tools get the default context
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
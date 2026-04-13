import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { handleStartChat, handlePollChat } from './agent/agent.js';

import { initializeToolRegistry, getToolRegistry, Tool } from './utils/toolRegistry.js';
import { getToolDetails, callTool } from './mcp/metaTools.js';

// We'll use the isTool from toolRegistry.ts instead
import { isTool } from './utils/toolRegistry.js';

function createMcpServer(tools: Tool[]): McpServer {
    const server = new McpServer({ name: "tridion-sites-mcp-server", version: "1.0.0" });

    for (const potentialTool of tools) {
        server.registerTool(
            potentialTool.name,
            {
                description: potentialTool.description,
                inputSchema: potentialTool.input,
            },
            (args: any, context: any) => {
                return potentialTool.execute(args, context);
            }
        );
    }

    return server;
}

async function startServer() {
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    // 1. Initialize the tool registry
    await initializeToolRegistry([]);
    const registry = getToolRegistry();

    // 2. Define the tools to be exposed via MCP (only the meta-tools)
    const mcpTools = [getToolDetails as Tool, callTool as Tool];

    const toolsAsRecord: Record<string, Tool> = {};
    registry.forEach((tool, name) => {
        toolsAsRecord[name] = tool;
    });

    const MCP_API_KEY = process.env.MCP_API_KEY || "demo-secret-key";

    const httpServer = http.createServer(async (req, res) => {
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

                    const orchestratorTool = toolsAsRecord['toolOrchestrator'];

                    if (!orchestratorTool) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: "toolOrchestrator not loaded on server." }));
                        return;
                    }

                    // 1. Manually construct the context expected by toolOrchestrator.ts
                    // The orchestrator expects { tools: ... } in the context to function.
                    const executionContext = {
                        tools: toolsAsRecord
                    };

                    // 2. Execute the tool
                    // This bypasses the McpServer wrapper and calls the underlying tool code directly.
                    const result = await orchestratorTool.execute(input, executionContext);

                    // 3. Unwrap the MCP response format to return clean JSON to the UI.
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
            // Pass the meta-tools to the agent chat
            handleStartChat(req, res, mcpTools);
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

        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', async () => {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(body);
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                    return;
                }

                if (sessionId && sessions.has(sessionId)) {
                    // Existing session
                    await sessions.get(sessionId)!.handleRequest(req, res, parsed);
                } else if (isInitializeRequest(parsed)) {
                    // New session — allow re-initialization even if a stale session ID was provided
                    // (e.g. after server restart, clients like Gemini CLI may re-send initialize with their old session ID)
                    const transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => randomUUID(),
                        onsessioninitialized: (newSessionId) => {
                            sessions.set(newSessionId, transport);
                        }
                    });
                    transport.onclose = () => {
                        const sid = transport.sessionId;
                        if (sid) sessions.delete(sid);
                    };
                    const server = createMcpServer(mcpTools);
                    await server.connect(transport);
                    await transport.handleRequest(req, res, parsed);
                } else if (sessionId && !sessions.has(sessionId)) {
                    // Stale session ID with a non-initialize request (e.g. after server restart).
                    // Handle statelessly — create a fresh per-request transport so clients like
                    // Gemini CLI don't need to reinitialize manually after a server restart.
                    const transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: undefined, // stateless: no session ID assigned or stored
                    });
                    const server = createMcpServer(mcpTools);
                    await server.connect(transport);
                    await transport.handleRequest(req, res, parsed);
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Bad request' }));
                }
            });
        } else if (req.method === 'GET' || req.method === 'DELETE') {
            if (sessionId && sessions.has(sessionId)) {
                await sessions.get(sessionId)!.handleRequest(req, res);
            } else if (sessionId && !sessions.has(sessionId)) {
                // Stale session ID — 404 signals clients to re-initialize
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Session not found' }));
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bad request: missing session ID' }));
            }
        } else {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
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
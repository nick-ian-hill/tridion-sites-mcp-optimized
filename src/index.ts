/**
 * In Stdio mode, stdout MUST be reserved for MCP JSON-RPC protocol messages.
 * We intercept all writes to process.stdout and only allow valid JSON-RPC
 * messages through. Everything else is redirected to stderr.
 */
if (process.env.MCP_TRANSPORT === 'stdio') {
    const originalStdoutWrite = process.stdout.write;
    // @ts-ignore
    process.stdout.write = (chunk, encoding, callback) => {
        const str = chunk.toString();
        try {
            // If it's a valid JSON-RPC message, let it through to stdout
            JSON.parse(str);
            return originalStdoutWrite.apply(process.stdout, [chunk, encoding, callback]);
        } catch (e) {
            // Otherwise, redirect to stderr to prevent connection closure
            return process.stderr.write(chunk, encoding, callback);
        }
    };

    // Also redirect console as a secondary layer
    console.log = (...args) => console.error(...args);
    console.warn = (...args) => console.error(...args);
}

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { initializeToolRegistry, Tool } from './utils/toolRegistry.js';
import { getToolDetails, callTool } from './mcp/metaTools.js';

/**
 * Creates and configures an McpServer instance.
 */
function createMcpServer(): McpServer {
    return new McpServer({
        name: "tridion-sites-mcp-server",
        version: "0.1.0"
    });
}

/**
 * Registers the meta-tools on the server.
 * This should be called AFTER initializeToolRegistry to ensure tool summaries are populated.
 */
function registerMetaTools(server: McpServer) {
    const mcpTools = [getToolDetails as Tool, callTool as Tool];

    for (const tool of mcpTools) {
        server.registerTool(
            tool.name,
            {
                description: tool.description,
                inputSchema: tool.input,
            },
            (args: any, context: any) => {
                return tool.execute(args, context);
            }
        );
    }
}

/**
 * Main entry point. Supports Stdio and Streamable HTTP transports.
 * Configure via MCP_TRANSPORT environment variable ('stdio' or 'http').
 */
async function startServer() {
    const transportType = (process.env.MCP_TRANSPORT || 'http').toLowerCase();

    // 1. Initialize the tool registry (loads all tools from src/tools/)
    // This takes ~2-3s but MUST happen before we register capabilities/connect
    // because the MCP SDK doesn't allow registering tools after a connection is active.
    // Our global stdout interception ensures this internal logging doesn't break Stdio.
    await initializeToolRegistry([]);

    // 2. Create the server and register meta-tools
    const server = createMcpServer();
    registerMetaTools(server);

    if (transportType === 'stdio') {
        // --- Stdio Transport (Standard for CLI and Desktop integrations) ---
        const transport = new StdioServerTransport();

        console.error("Connecting Tridion Sites MCP Server (Stdio)...");
        await server.connect(transport);
        console.error("Server connected.");
    } else {
        // --- Streamable HTTP Transport (Legacy/SSE support) ---
        const sessions = new Map<string, StreamableHTTPServerTransport>();
        const port = process.env.PORT ? parseInt(process.env.PORT) : 8090;

        const httpServer = http.createServer(async (req, res) => {
            // Standard CORS for local development UI access if needed
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, mcp-session-id');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            const sessionId = req.headers['mcp-session-id'] as string | undefined;

            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                req.on('end', async () => {
                    let parsed: any;
                    try {
                        parsed = JSON.parse(body);
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid JSON' }));
                        return;
                    }

                    if (sessionId && sessions.has(sessionId)) {
                        await sessions.get(sessionId)!.handleRequest(req, res, parsed);
                    } else if (isInitializeRequest(parsed)) {
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
                        await server.connect(transport);
                        await transport.handleRequest(req, res, parsed);
                    } else {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Session not found or invalid request' }));
                    }
                });
            } else if (req.method === 'GET' || req.method === 'DELETE') {
                if (sessionId && sessions.has(sessionId)) {
                    await sessions.get(sessionId)!.handleRequest(req, res);
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Session not found' }));
                }
            } else {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method not allowed' }));
            }
        });

        httpServer.listen(port, () => {
            console.error(`Tridion Sites MCP Server listening (Streamable HTTP) on port ${port}`);
        });
    }
}

startServer().catch((error) => {
    console.error("Fatal error starting server:", error);
    process.exit(1);
});
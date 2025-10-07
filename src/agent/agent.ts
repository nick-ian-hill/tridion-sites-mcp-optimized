import http from 'node:http';
import { Orchestrator } from './orchestrator.js';
import { MessageEmitter } from './types.js';

export async function handleAgentChat(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    tools: any[],
    isStreaming: boolean
) {
    if (isStreaming) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        req.socket.setNoDelay(true);
    }

    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', () => {
        try {
            const parsedBody = JSON.parse(body || '{}');
            const { prompt, context, history = [] } = parsedBody;

            if (isStreaming) {
                const eventEmitter: MessageEmitter = (event, data) => {
                    if (!res.writableEnded) {
                        res.write(`event: ${event}\n`);
                        res.write(`data: ${JSON.stringify(data)}\n\n`);
                    }
                };
                
                const orchestrator = new Orchestrator({ req, allTools: tools, emit: eventEmitter });

                orchestrator.process(prompt, context?.itemId, history)
                    .catch(e => {
                        const error = e instanceof Error ? e : new Error(String(e));
                        console.error("[Agent] Orchestrator process promise rejected critically.", error);
                        if (!res.writableEnded) {
                             eventEmitter('error', { message: `A critical server error occurred: ${error.message}` });
                        }
                    })
                    .finally(() => {
                        if (!res.writableEnded) {
                            res.end();
                        }
                    });

            } else {
                (async () => {
                    let finalResult: any = null;
                    const eventEmitter: MessageEmitter = (event, data) => {
                        if (event === 'result') finalResult = data;
                        if (event === 'error') finalResult = { error: data };
                    };
                    
                    const orchestrator = new Orchestrator({ req, allTools: tools, emit: eventEmitter });
                    await orchestrator.process(prompt, context?.itemId, history);

                    res.writeHead(finalResult?.error ? 500 : 200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(finalResult || { message: "Task completed without a final result." }));
                })().catch(e => {
                    const error = e instanceof Error ? e : new Error(String(e));
                    console.error("[Agent] Non-streaming orchestrator failed critically:", error);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `Agent Error: ${error.message}` }));
                    }
                });
            }
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            console.error("[Agent] Failed to process request:", error);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
            }
            if (!res.writableEnded) {
                res.end(JSON.stringify({ error: `Agent Error: ${error.message}` }));
            }
        }
    });
}
import http from 'node:http';
import * as crypto from 'crypto';
import { Orchestrator } from './orchestrator.js';
import { MessageEmitter } from './types.js';
import { createTask, addTaskEvent, getTaskEvents } from './taskStore.js';

/**
 * Handles the initial request to start a new chat task.
 * It kicks off the orchestrator in the background and immediately returns a taskId.
 */
export function handleStartChat(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    tools: any[]
) {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', () => {
        try {
            const parsedBody = JSON.parse(body || '{}');
            const { prompt, context, history = [], attachments } = parsedBody;

            const taskId = crypto.randomUUID();
            createTask(taskId);

            // The event emitter pushes events to the in-memory store.
            const eventEmitter: MessageEmitter = (event, data) => {
                addTaskEvent(taskId, { type: event, data });
            };

            const orchestrator = new Orchestrator({ req, allTools: tools, emit: eventEmitter });

            // Run the orchestrator process in the background. Do not `await` it.
            // It will run to completion and add events to the task store.
            orchestrator.process(prompt, context, history, attachments)
                .catch(err => {
                    console.error(`[Agent] Background task ${taskId} failed:`, err);
                    // Add a final error event to the store if the process crashes.
                    addTaskEvent(taskId, { type: 'error', data: { message: 'The agent process encountered a critical failure.' } });
                });
            
            // Immediately respond with the taskId so the client can start polling.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ taskId }));

        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            console.error("[Agent] Failed to start task:", error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Agent Error: ${error.message}` }));
        }
    });
}

/**
 * Handles long polling requests from the client to get task updates.
 */
export function handlePollChat(
    req: http.IncomingMessage,
    res: http.ServerResponse
) {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', async () => {
        try {
            const parsedBody = JSON.parse(body || '{}');
            const { taskId } = parsedBody;

            if (!taskId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'taskId is required.' }));
            }

            // Fetch events for the task. This function will wait for new events or timeout.
            const events = await getTaskEvents(taskId);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ events }));
        
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            console.error("[Agent] Failed to poll for updates:", error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Agent Error: ${error.message}` }));
        }
    });
}
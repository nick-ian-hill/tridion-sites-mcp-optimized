import http from 'node:http';
import { filterResponseData } from '../utils/responseFiltering.js';
import { Task, PlanStep, MessageEmitter, Content } from './types.js';
import { determineNextStep, summarizeToolOutput } from './gemini.js';
import { READ_ONLY_TOOLS } from './readOnlyTools.js';
import { AxiosError } from 'axios';

interface OrchestratorOptions {
    req: http.IncomingMessage;
    allTools: any[];
    emit: MessageEmitter;
}

export class Orchestrator {
    private req: http.IncomingMessage;
    private allTools: any[];
    private emit: MessageEmitter;

    constructor({ req, allTools, emit }: OrchestratorOptions) {
        this.req = req;
        this.allTools = allTools;
        this.emit = emit;
        console.log('[Agent] Orchestrator initialized.');
    }

    async process(prompt: string, contextItemId: string | undefined, history: Content[]) {
        const availableTools = this.allTools;
        
        const task: Task = {
            id: 'task-' + Date.now(),
            originalPrompt: prompt,
            plan: [],
            currentStep: 0,
            contextItemId: contextItemId,
            history: history,
            shouldInvalidateContext: false,
        };

        task.history.push({ role: 'user', parts: [{ text: prompt }] });
        
        let finalMessage = "Task failed to complete.";

        try {
            const MAX_STEPS = 25;
            for (let i = 0; i < MAX_STEPS; i++) {
                
                const nextStep = await determineNextStep(
                    task.originalPrompt,
                    task.contextItemId,
                    task.history,
                    availableTools
                );

                if (!nextStep || nextStep.tool === 'finish') {
                    if (nextStep?.args.finalMessage === '__NEEDS_SUMMARY__') {
                        const lastStep = task.plan[task.plan.length - 1];
                        if (lastStep && lastStep.status === 'completed') {
                            finalMessage = await summarizeToolOutput(lastStep.result, task.originalPrompt);
                        } else {
                            finalMessage = "The task is complete.";
                        }
                    } else {
                        finalMessage = nextStep?.args?.finalMessage || "Task completed successfully.";
                    }
                    break;
                }

                task.plan.push(nextStep);
                
                await this.executeStep(nextStep, task);

                if (i === MAX_STEPS - 1) {
                    finalMessage = "Task stopped as it reached the maximum number of steps.";
                }
            }

            this.emit('result', {
                message: finalMessage,
                history: task.history,
                shouldInvalidateContext: task.shouldInvalidateContext
            });

        } catch (error) {
            this.emit('plan', { plan: task.plan });

            if (error instanceof AxiosError && error.response?.status === 401) {
                finalMessage = "Authentication failed. Your session may have expired. Please refresh the page and try again.";
            } else if (error instanceof Error) {
                finalMessage = `The task failed with an error: ${error.message}`;
            } else {
                finalMessage = "The task failed with an unknown error.";
            }

            this.emit('result', {
                message: finalMessage,
                history: task.history,
                shouldInvalidateContext: task.shouldInvalidateContext
            });
        }
    }

    private async executeStep(step: PlanStep, task: Task) {
        step.status = 'in-progress';
        
        const argsSummary = JSON.stringify(step.args, null, 2);
        this.emit('progress', { 
            isLog: true, 
            message: `Calling tool: **${step.tool}**\n\`\`\`json\n${argsSummary}\n\`\`\`` 
        });

        try {
            const toolToExecute = this.allTools.find(t => t.name === step.tool);
            if (!toolToExecute) throw new Error(`Tool '${step.tool}' not found.`);

            const result = await toolToExecute.execute(step.args, { request: this.req });

            step.status = 'completed';
            this.handleToolResult(result, step, task);

            /* Uncomment this to see the tool response in the chat
            const resultSummary = JSON.stringify(step.result, null, 2);
            this.emit('progress', {
                isLog: true,
                message: `Tool **${step.tool}** returned:\n\`\`\`json\n${resultSummary}\n\`\`\``
            });
            */
            
            let responseForHistory = step.result;

            if (Array.isArray(responseForHistory)) {
                responseForHistory = { items: responseForHistory };
            } 
            else if (typeof responseForHistory !== 'object' || responseForHistory === null) {
                responseForHistory = { output: responseForHistory };
            }

            task.history.push({ role: 'model', parts: [{ functionCall: { name: step.tool, args: step.args } }] });
            task.history.push({ role: 'function', parts: [{ functionResponse: { name: step.tool, response: responseForHistory } }] });
            
            this.emit('progress', {
                isLog: true,
                message: `Received response from **${step.tool}**. Now deciding next step...`
            });

        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            step.status = 'failed';
            step.error = error.message;

            task.history.push({ role: 'model', parts: [{ functionCall: { name: step.tool, args: step.args } }] });
            task.history.push({ role: 'function', parts: [{ functionResponse: { name: step.tool, response: { error: error.message } } }] });

            this.emit('error', { message: `Step ${step.step} failed: ${error.message}`, step: step.step });
        }
    }

    private handleToolResult(result: any, step: PlanStep, task: Task) {
        if (!task.shouldInvalidateContext && !READ_ONLY_TOOLS.includes(step.tool)) {
            task.shouldInvalidateContext = true;
        }
        if (result?.isUiAction && result.action) {
            this.emit('ui-action', result.action);
        }

        let cleanResult = result;
        if (
            result?.content && 
            Array.isArray(result.content) && 
            result.content[0]?.type === 'text' && 
            typeof result.content[0].text === 'string'
        ) {
            const rawText = result.content[0].text;
            try {
                const jsonStartIndex = rawText.indexOf('{');
                if (jsonStartIndex > -1) {
                    // If a '{' is found, extract the substring from that point onwards.
                    const jsonString = rawText.substring(jsonStartIndex);
                    cleanResult = JSON.parse(jsonString);
                } else {
                    // If no JSON object is found, treat the entire output as plain text.
                    cleanResult = rawText;
                }

            } catch (e) {
                console.warn(`[Orchestrator] Could not parse JSON from tool '${step.tool}' result text. Using raw text.`);
                cleanResult = result.content[0].text;
            }
        }
        
        step.result = filterResponseData({ responseData: cleanResult });
    }
}
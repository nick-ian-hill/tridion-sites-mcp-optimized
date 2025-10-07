import http from 'node:http';
import { filterResponseData } from '../utils/responseFiltering.js';
import { Task, PlanStep, MessageEmitter, Content } from './types.js';
import { selectRelevantTools, determineNextStep } from './gemini.js';
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

    /**
     * Main processing method using the ReAct (Reason-Act) loop.
     */
    async process(prompt: string, contextItemId: string | undefined, history: Content[]) {
        const selectedTools = await selectRelevantTools(prompt, this.allTools);
        
        const task: Task = {
            id: 'task-' + Date.now(),
            originalPrompt: prompt,
            plan: [], // The plan is built dynamically
            currentStep: 0,
            contextItemId: contextItemId,
            history: history,
            shouldInvalidateContext: false,
        };

        task.history.push({ role: 'user', parts: [{ text: prompt }] });
        
        let finalMessage = "Task failed to complete.";

        try {
            const MAX_STEPS = 25; // Safeguard against infinite loops
            for (let i = 0; i < MAX_STEPS; i++) {
                
                const nextStep = await determineNextStep(
                    task.originalPrompt,
                    task.contextItemId,
                    task.history,
                    selectedTools
                );

                if (!nextStep || nextStep.tool === 'finish') {
                    finalMessage = nextStep?.args?.finalMessage || "Task completed successfully.";
                    break; // Exit the loop
                }

                task.plan.push(nextStep);
                this.emit('plan', { plan: task.plan }); // Emit the dynamically growing plan
                
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
            // Robust error handling logic
            this.emit('plan', { plan: task.plan }); // Emit the final state of the plan

            if (error instanceof AxiosError && error.response?.status === 401) {
                finalMessage = "Authentication failed. Your session may have expired. Please refresh the page and try again.";
            } else if (error instanceof Error) {
                finalMessage = `The task failed with an error: ${error.message}`;
            } else {
                finalMessage = "The task failed with an unknown error.";
            }

            // Emit a final result event with the specific error message
            this.emit('result', {
                message: finalMessage,
                history: task.history,
                shouldInvalidateContext: task.shouldInvalidateContext
            });
        }
    }

    private async executeStep(step: PlanStep, task: Task) {
        step.status = 'in-progress';
        this.emit('progress', { message: `Starting step ${step.step}: Calling ${step.tool}`, step: step.step });

        try {
            const toolToExecute = this.allTools.find(t => t.name === step.tool);
            if (!toolToExecute) throw new Error(`Tool '${step.tool}' not found.`);

            const result = await toolToExecute.execute(step.args, { request: this.req });

            step.status = 'completed';
            step.result = result;
            this.handleToolResult(result, step, task);
            
            // This history is CRITICAL for the next loop iteration
            task.history.push({ role: 'model', parts: [{ functionCall: { name: step.tool, args: step.args } }] });
            task.history.push({ role: 'function', parts: [{ functionResponse: { name: step.tool, response: step.result } }] });

        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            step.status = 'failed';
            step.error = error.message;

            // Add the error to the history so the model knows the tool failed
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
        step.result = filterResponseData({ responseData: result });
    }
}
import http from 'node:http';
import { filterResponseData } from '../utils/responseFiltering.js';
import { Task, PlanStep, MessageEmitter, Content } from './types.js';
import { determineNextStep, summarizeToolOutput, detectIntent, selectRelevantTools, DetectedIntent } from './gemini.js';
import { READ_ONLY_TOOLS } from './readOnlyTools.js';
import { AxiosError } from 'axios';
import { prepareHistoryForModel } from './historyUtils.js';
import { FunctionCallingConfigMode } from '@google/genai';

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
            // ==========================================================
            // Dynamic Router with Adaptive Function Calling Mode
            // ==========================================================
            this.emit('progress', { isLog: true, message: "Analyzing user's request..." });
            const intent: DetectedIntent = await detectIntent(prompt);

            let availableTools: any[];
            let functionCallingMode: FunctionCallingConfigMode;

            // --- Configure strategy based on intent ---
            if (intent.strategy === 'FORCE_TOOL_CALL') {
                this.emit('progress', { isLog: true, message: "Strategy: Force Tool Call. Selecting relevant tools..." });
                availableTools = await selectRelevantTools(prompt, this.allTools);
                functionCallingMode = FunctionCallingConfigMode.ANY;
                
                this.emit('progress', {
                   isLog: true,
                   message: `Tool router selected ${availableTools.length}/${this.allTools.length} tools for this task.`
                });

            } else { // AUTO_MODE
                this.emit('progress', { isLog: true, message: "Strategy: Auto Mode. Using all available tools..." });
                availableTools = this.allTools;
                functionCallingMode = FunctionCallingConfigMode.AUTO;
            }
            
            finalMessage = await this.executePlan(task, availableTools, prompt, functionCallingMode);

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

    private async executePlan(task: Task, availableTools: any[], latestPrompt: string, functionCallingMode: FunctionCallingConfigMode): Promise<string> {
        const MAX_STEPS = 25;
        for (let i = 0; i < MAX_STEPS; i++) {
            const preparedHistory = prepareHistoryForModel(task.history);
            const nextStep = await determineNextStep(
                latestPrompt,
                task.contextItemId,
                preparedHistory,
                availableTools,
                functionCallingMode
            );

            if (!nextStep || nextStep.tool === 'finish') {
                if (nextStep?.args.finalMessage === '__NEEDS_SUMMARY__') {
                    const lastStep = task.plan[task.plan.length - 1];
                    if (lastStep && lastStep.status === 'completed') {
                        return await summarizeToolOutput(lastStep.result, latestPrompt);
                    }
                    return "The task is complete.";
                }
                return nextStep?.args?.finalMessage || "Task completed successfully.";
            }

            task.plan.push(nextStep);
            await this.executeStep(nextStep, task);

            if (i === MAX_STEPS - 1) {
                return "Task stopped as it reached the maximum number of steps.";
            }
        }
        return "Task finished unexpectedly.";
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
            
            let responseForHistory;
            const isReadOnly = READ_ONLY_TOOLS.includes(step.tool);

            if (isReadOnly) {
                responseForHistory = step.result;
            } else {
                if (typeof step.result === 'object' && step.result !== null && step.result.Id) {
                    responseForHistory = { status: 'success', itemId: step.result.Id };
                } else {
                    responseForHistory = { status: 'success' };
                }
            }
            
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
                const jsonStartIndex = rawText.search(/[[{]/);
                if (jsonStartIndex > -1) {
                    const jsonString = rawText.substring(jsonStartIndex);
                    cleanResult = JSON.parse(jsonString);
                } else {
                    cleanResult = rawText;
                }
            } catch (e) {
                console.warn(`[Orchestrator] Could not parse JSON from tool '${step.tool}' result text. Using raw text.`);
                cleanResult = rawText;
            }
        }
        
        step.result = filterResponseData({ responseData: cleanResult });
    }
}
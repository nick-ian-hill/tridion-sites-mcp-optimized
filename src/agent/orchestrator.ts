import http from 'node:http';
import { filterResponseData } from '../utils/responseFiltering.js';
import { Task, PlanStep, MessageEmitter, Content } from './types.js';
import { determineNextStep, summarizeToolOutput, selectRelevantTools, detectIntent, DetectedIntent, MANDATORY_TOOLS } from './gemini.js';
import { READ_ONLY_TOOLS } from './readOnlyTools.js';
import { AxiosError } from 'axios';
import { prepareHistoryForModel } from './historyUtils.js';

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
            this.emit('progress', { isLog: true, message: "Analyzing user's request and complexity..." });
            const intent: DetectedIntent = await detectIntent(prompt);

            let availableTools: any[];

            switch (intent.strategy) {
                case 'SIMPLE_ACTION':
                    this.emit('progress', { isLog: true, message: "Strategy: Simple Action. Selecting a small toolset..." });
                    availableTools = await selectRelevantTools(prompt, this.allTools, MANDATORY_TOOLS.length + 1);
                    break;
                
                case 'MEDIUM_ACTION':
                    this.emit('progress', { isLog: true, message: "Strategy: Medium Action. Selecting a medium toolset..." });
                    availableTools = await selectRelevantTools(prompt, this.allTools, 20);
                    break;
                
                case 'COMPLEX_OR_GENERAL':
                default:
                    this.emit('progress', { isLog: true, message: "Strategy: Complex/General. Using all available tools..." });
                    availableTools = this.allTools;
                    break;
            }

             if (intent.strategy !== 'COMPLEX_OR_GENERAL') {
                this.emit('progress', {
                    isLog: true,
                    message: `Tool router selected ${availableTools.length}/${this.allTools.length} tools for this task.`
                });
            }
            
            finalMessage = await this.executePlan(task, availableTools, prompt);

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

    private async executePlan(task: Task, availableTools: any[], latestPrompt: string): Promise<string> {
        const MAX_STEPS = 20;
        for (let i = 0; i < MAX_STEPS; i++) {
            const preparedHistory = prepareHistoryForModel(task.history);
            
            const { planStep: nextStep, modelResponseContent } = await determineNextStep(
                latestPrompt,
                task.contextItemId,
                preparedHistory,
                availableTools
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
            
            if (modelResponseContent) {
                task.history.push(modelResponseContent as Content);
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

            task.history.push({ role: 'function', parts: [{ functionResponse: { name: step.tool, response: responseForHistory } }] });

            this.emit('progress', {
                isLog: true,
                message: `Received response from **${step.tool}**. Now deciding next step...`
            });

        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            step.status = 'failed';
            step.error = error.message;

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
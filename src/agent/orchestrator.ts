import http from 'node:http';
import { filterResponseData } from '../utils/responseFiltering.js';
import { Task, PlanStep, MessageEmitter, Content, AgentContext } from './types.js';
import { determineNextStep, summarizeToolOutput } from './gemini.js';
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

    async process(prompt: string, context: AgentContext | undefined, history: Content[]) {
        const task: Task = {
            id: 'task-' + Date.now(),
            originalPrompt: prompt,
            plan: [],
            currentStep: 0,
            context: context,
            history: history,
            shouldInvalidateContext: false,
        };

        task.history.push({ role: 'user', parts: [{ text: prompt }] });

        let finalMessage = "Task failed to complete.";

        try {
            this.emit('progress', {
                isLog: true,
                message: `Starting task...`
            });

            finalMessage = await this.executePlan(task, this.allTools, prompt);

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

            this.emit('progress', {
                isLog: false,
                message: i === 0 ? 'Generating response...' : 'Planning next step...'
            });

            const { planSteps: nextSteps, modelResponseContent } = await determineNextStep(
                latestPrompt,
                task.context,
                preparedHistory,
                availableTools
            );

            if (modelResponseContent) {
                task.history.push(modelResponseContent as Content);
            }

            // Separate the finish step from real backend action steps
            const finishStep = nextSteps.find(s => s.tool === 'finish');
            const actionSteps = nextSteps.filter(s => s.tool !== 'finish');

            let hasFailures = false;

            // 1. Iterate through ALL actual parallel action steps and execute them
            for (const step of actionSteps) {
                task.plan.push(step);
                await this.executeStep(step, task);
                if (step.status === 'failed') {
                    hasFailures = true;
                }
            }

            // 2. Handle the finish step (if present)
            if (finishStep) {
                if (hasFailures) {
                    // Provide a response to satisfy Gemini's strict turn validation, but do NOT end the task
                    task.history.push({
                        role: 'function',
                        parts: [{
                            functionResponse: { name: 'finish', response: { error: 'Aborted finish execution because a parallel tool step failed.' } }
                        }]
                    });
                } else {
                    // Success path: push dummy success response to complete the function calling turn
                    task.history.push({
                        role: 'function',
                        parts: [{
                            functionResponse: { name: 'finish', response: { status: 'success' } }
                        }]
                    });

                    // Handle the special summarization request
                    if (finishStep.args?.taskConfirmation === '__NEEDS_SUMMARY__') {
                        const lastStep = task.plan[task.plan.length - 1];
                        if (lastStep && lastStep.status === 'completed') {
                            return await summarizeToolOutput(lastStep.result, latestPrompt);
                        }
                    }

                    // Prioritize the structured taskConfirmation from the model
                    const confirmation = finishStep.args?.taskConfirmation;
                    if (confirmation && confirmation !== '__NEEDS_SUMMARY__') {
                        return confirmation;
                    }
                }
            }

            // 3. End the execution if there are no steps, OR if we successfully finished without failures
            if (nextSteps.length === 0 || (finishStep && !hasFailures)) {
                // Fallback: Try to extract raw text
                if (modelResponseContent) {
                    const textParts = modelResponseContent.parts
                        ?.filter((part: any) => 'text' in part)
                        .map((part: any) => part.text)
                        .filter((text: string) => text.trim().length > 0);

                    if (textParts && textParts.length > 0) {
                        const fullText = textParts.join('\n\n');
                        console.log('[Orchestrator] Using fallback text response from model:', fullText.substring(0, 100) + '...');
                        return fullText;
                    }
                }

                return "Task completed successfully.";
            }

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
            logCategory: 'tool-call',
            toolName: step.tool,
            args: step.args,
            message: `Calling tool: **${step.tool}**\n\`\`\`json\n${argsSummary}\n\`\`\``
        });

        try {
            const toolToExecute = this.allTools.find(t => t.name === step.tool);
            if (!toolToExecute) throw new Error(`Tool '${step.tool}' not found.`);

            // Provide the tools dictionary to the execution context so toolOrchestrator can use them
            const toolsDict: Record<string, any> = {};
            this.allTools.forEach(t => toolsDict[t.name] = t);

            const result = await toolToExecute.execute(step.args, {
                request: this.req,
                tools: toolsDict
            });

            step.status = 'completed';
            this.handleToolResult(result, step, task);

            let responseForHistory;
            const isReadOnly = READ_ONLY_TOOLS.includes(step.tool);

            // Check if the "result" contains error indicators
            const isErrorResult = step.result && (step.result.type === 'Error' || step.result.ErrorCode);

            if (isErrorResult) {
                step.status = 'failed';
                step.error = step.result.Message || "Unknown tool error";
                responseForHistory = {
                    error: step.error,
                    ...(step.result.Details && { details: step.result.Details })
                };

                // We purposefully do NOT throw here, allowing the agent to see the error 
                // in the history and try to self-correct.
            } else if (isReadOnly || step.tool === 'toolOrchestrator') {
                responseForHistory = step.result;
            } else {
                if (typeof step.result === 'object' && step.result !== null && step.result.Id) {
                    responseForHistory = { status: 'success', itemId: step.result.Id };
                } else {
                    responseForHistory = { status: 'success' };
                }
            }

            if (!isErrorResult) {
                if (Array.isArray(responseForHistory)) {
                    responseForHistory = { items: responseForHistory };
                }
                else if (typeof responseForHistory !== 'object' || responseForHistory === null) {
                    responseForHistory = { output: responseForHistory };
                }
            }

            task.history.push({ role: 'function', parts: [{ functionResponse: { name: step.tool, response: responseForHistory } }] });

            this.emit('progress', {
                isLog: true,
                logCategory: 'tool-result',
                toolName: step.tool,
                message: `Received response from **${step.tool}**.`
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

        let cleanResult = result;

        // First, parse JSON from text if needed
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

        // Check for ui-action on the parsed result
        if (cleanResult?.isUiAction && cleanResult.action) {
            this.emit('ui-action', cleanResult.action);
        }

        step.result = filterResponseData({ responseData: cleanResult });
    }
}
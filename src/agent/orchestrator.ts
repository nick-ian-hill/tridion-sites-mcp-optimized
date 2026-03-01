import http from 'node:http';
import { filterResponseData } from '../utils/responseFiltering.js';
import { Task, PlanStep, MessageEmitter, Content, AgentContext } from './types.js';
import { determineNextStep, summarizeToolOutput, assessTaskProgress } from './gemini.js';
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
        let maxTurns = 20; // Starting limit
        let hasExtended = false; // Tracks if we already gave the agent the +10 bonus
        let consecutiveFailures = 0;
        let useAdvancedModel = false;

        for (let i = 0; i < maxTurns; i++) {
            const preparedHistory = prepareHistoryForModel(task.history);

            this.emit('progress', {
                isLog: false,
                message: i === 0 ? 'Generating response...' : 'Planning next step...'
            });

            const { planSteps: nextSteps, modelResponseContent } = await determineNextStep(
                latestPrompt,
                task.context,
                preparedHistory,
                availableTools,
                useAdvancedModel
            );

            if (modelResponseContent) {
                task.history.push(modelResponseContent as Content);
            }

            const finishStep = nextSteps.find(s => s.tool === 'finish');
            const actionSteps = nextSteps.filter(s => s.tool !== 'finish');

            let hasFailures = false;

            // Execute parallel actions concurrently
            const executionPromises = actionSteps.map(async (step) => {
                task.plan.push(step);
                await this.executeStep(step, task);
                if (step.status === 'failed') {
                    hasFailures = true;
                }
            });

            await Promise.allSettled(executionPromises);

            // Progress and escalation logic
            if (actionSteps.length > 0) {
                if (hasFailures) {
                    consecutiveFailures++;
                    
                    if (consecutiveFailures === 2 && !useAdvancedModel) {
                        this.emit('progress', { isLog: true, message: "Encountered repeated errors. Escalating to advanced model for recovery..." });
                        useAdvancedModel = true;
                    } else if (consecutiveFailures >= 4) {
                        this.emit('progress', { isLog: true, message: "Advanced model also failing. Requesting user intervention." });
                        
                        task.history.push({
                            role: 'function',
                            parts: [{ functionResponse: { name: 'finish', response: { status: 'stuck_on_errors' } } }]
                        });
                        
                        return "I'm having trouble completing this task even with my advanced reasoning model. I've hit 4 consecutive errors. Could you clarify the requirement or provide some guidance?";
                    }
                } else {
                    consecutiveFailures = 0;
                    useAdvancedModel = false; 
                }
            }

            // Handle Finish Step
            if (finishStep) {
                if (hasFailures) {
                    task.history.push({
                        role: 'function',
                        parts: [{ functionResponse: { name: 'finish', response: { error: 'Action failed. Reviewing error and retrying...' } } }]
                    });
                } else {
                    task.history.push({
                        role: 'function',
                        parts: [{ functionResponse: { name: 'finish', response: { status: 'success' } } }]
                    });

                    if (finishStep.args?.taskConfirmation === '__NEEDS_SUMMARY__') {
                        const lastStep = task.plan[task.plan.length - 1];
                        if (lastStep && lastStep.status === 'completed') {
                            return await summarizeToolOutput(lastStep.result, latestPrompt);
                        }
                    }

                    const confirmation = finishStep.args?.taskConfirmation;
                    if (confirmation && confirmation !== '__NEEDS_SUMMARY__') {
                        return confirmation;
                    }
                }
            }

            // End execution if task is genuinely complete
            if (nextSteps.length === 0 || (finishStep && !hasFailures)) {
                if (modelResponseContent) {
                    const textParts = modelResponseContent.parts
                        ?.filter((part: any) => 'text' in part)
                        .map((part: any) => part.text)
                        .filter((text: string) => text.trim().length > 0);

                    if (textParts && textParts.length > 0) {
                        return textParts.join('\n\n');
                    }
                }
                return "Task completed successfully.";
            }

            // --- OVERSEER PROGRESS CHECK ---
            // If we have reached the end of our current turn limit
            if (i === maxTurns - 1) {
                this.emit('progress', { isLog: true, message: `Reached turn limit (${maxTurns}). Evaluating progress...` });
                
                // Call the Pro model to judge the worker model's progress
                const assessment = await assessTaskProgress(preparedHistory, latestPrompt);

                // If making good progress and we haven't given an extension yet, grant +10 turns
                if (assessment.isMakingProgress && !hasExtended) {
                    this.emit('progress', { isLog: true, message: `Agent is making solid progress. Extending allowance by 10 turns...` });
                    maxTurns += 10; // Dynamically expands the for-loop!
                    hasExtended = true;
                    continue; 
                }

                // If NOT making progress, OR if we already extended and still hit the new limit, ask the user.
                this.emit('progress', { isLog: true, message: `Pausing for user permission.` });
                
                // Push dummy finish to close the function call array cleanly
                task.history.push({
                    role: 'function',
                    parts: [{ functionResponse: { name: 'finish', response: { status: 'paused' } } }]
                });

                return `I am taking longer than expected, but I want to check in before proceeding further.\n\n**Status Update:** ${assessment.progressSummary}\n\nWould you like me to continue or change my approach?`;
            }
        }
        return "Task paused.";
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
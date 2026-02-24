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
            
            // Emit progress event before model call
            this.emit('progress', { 
                isLog: false, 
                message: i === 0 ? 'Generating response...' : 'Planning next step...' 
            });
            
            // Get all steps for this turn (supports parallel calls)
            const { planSteps: nextSteps, modelResponseContent } = await determineNextStep(
                latestPrompt,
                task.context,
                preparedHistory,
                availableTools
            );

            // Push the model's full response (which includes ALL function or text responses) to history
            if (modelResponseContent) {
                task.history.push(modelResponseContent as Content);
            }

            // Check if the primary next step is to finish or if no steps were found
            const firstStep = nextSteps[0];
            if (!firstStep || firstStep.tool === 'finish') {
                // If the model called finish, push a dummy function response to history
                // to complete the function calling turn and maintain a valid history state.
                if (firstStep?.tool === 'finish') {
                    task.history.push({ 
                        role: 'function', 
                        parts: [{ 
                            functionResponse: { name: 'finish', response: { status: 'success' } } 
                        }] 
                    });
                }

                // Handle the special summarization request
                if (firstStep?.args?.taskConfirmation === '__NEEDS_SUMMARY__') {
                    const lastStep = task.plan[task.plan.length - 1];
                    if (lastStep && lastStep.status === 'completed') {
                        return await summarizeToolOutput(lastStep.result, latestPrompt);
                    }
                }
                
                // Prioritize the structured taskConfirmation from the model
                const confirmation = firstStep?.args?.taskConfirmation;
                if (confirmation && confirmation !== '__NEEDS_SUMMARY__') {
                    return confirmation;
                }
                
                // Fallback: If taskConfirmation is missing, try to extract raw text
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

            // Iterate through ALL parallel steps and execute them
            for (const step of nextSteps) {
                task.plan.push(step);
                await this.executeStep(step, task);
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

            const result = await toolToExecute.execute(step.args, { request: this.req });

            step.status = 'completed';
            this.handleToolResult(result, step, task);
            
            let responseForHistory;
            const isReadOnly = READ_ONLY_TOOLS.includes(step.tool);

            // Check if the "result" contains error indicators
            const isErrorResult = result && (result.type === 'Error' || result.ErrorCode);

            if (isErrorResult) {
                step.status = 'failed';
                step.error = result.Message || "Unknown tool error";
                responseForHistory = { error: step.error };
                
                // We purposefully do NOT throw here, allowing the agent to see the error 
                // in the history and try to self-correct.
            } else if (isReadOnly) {
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
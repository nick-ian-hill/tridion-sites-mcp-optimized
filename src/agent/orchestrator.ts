import http from 'node:http';
import { filterResponseData } from '../utils/responseFiltering.js';
import { Task, PlanStep, MessageEmitter, Content, AgentContext, Attachment } from './types.js';
import { determineNextStep, summarizeToolOutput, assessTaskProgress, summarizeFailureState } from './gemini.js';
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

    async process(prompt: string, context: AgentContext | undefined, history: Content[], attachments?: Attachment[]) {
        const task: Task = {
            id: 'task-' + Date.now(),
            originalPrompt: prompt,
            plan: [],
            currentStep: 0,
            context: context,
            history: history,
            shouldInvalidateContext: false,
        };

        const contextString = this.formatContext(context);
        const attachmentsString = this.formatAttachments(attachments);
        const suffix = contextString + attachmentsString;
        const combinedPrompt = suffix ? `${prompt}${suffix}` : prompt;

        task.history.push({ role: 'user', parts: [{ text: combinedPrompt }] });

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

    /**
     * Formats attached file metadata into a human-readable prompt suffix so the
     * LLM knows which files are available and how to process them.
     */
    private formatAttachments = (attachments?: Attachment[]): string => {
        if (!attachments || attachments.length === 0) {
            return '';
        }
        const list = attachments
            .map(a => `  - "${a.fileName}" (attachmentId: ${a.tempFileId})`)
            .join('\n');
        return `\n\nAttached Files (${attachments.length}):\n${list}\n\nBased on what the user is asking, choose the right tool for each attachment:\n- To **read or analyse** the content (e.g. extract text, summarise, import data into fields), call 'readUploadedFile' with the attachmentId and fileName.\n- To **save it as a new multimedia component** in the CMS, call 'createMultimediaComponentFromAttachment' with the attachmentId and fileName.\n- To **extract both text and embedded images** from a Word or PowerPoint file and create multimedia components for each image, call 'splitWordMultimediaComponentIntoTextAndImages' or 'splitPowerPointMultimediaComponentIntoTextAndImages' with the attachmentId and fileName.\n- To **generate a new AI image using an attachment as a style or composition reference**, call 'createMultimediaComponentFromPrompt' and pass the attachment(s) via the 'contextAttachments' parameter (each entry needs attachmentId and fileName).`;
    };

    /**
     * Formats the context object into a human-readable string for the system instruction.
     * Order matters: Container (where user is browsing) comes first, then selected items, then focused item.
     */
    private formatContext = (ctx: any): string => {
        if (!ctx) return '';

        const parts: string[] = [];

        // 1. Container - Most important: where the user is currently browsing
        if (ctx.container) {
            if (ctx.container.isVirtualNode) {
                // UI-only node — id is client-fabricated and cannot be used for backend API calls
                parts.push(`Browsing in: ${ctx.container.type} "${ctx.container.title}" (UI node: ${ctx.container.id})`);
            } else {
                parts.push(`Browsing in: ${ctx.container.type} "${ctx.container.title}" (${ctx.container.id})`);
            }
        }

        // 2. Selected items - Items the user has explicitly selected with checkboxes
        if (ctx.selectedItems && ctx.selectedItems.length > 0) {
            if (ctx.selectedItems.length === 1) {
                const item = ctx.selectedItems[0];
                parts.push(`Selected: ${item.type} "${item.title}" (${item.id})`);
            } else {
                parts.push(`Selected Items (${ctx.selectedItems.length}):`);
                ctx.selectedItems.forEach((item: any, index: number) => {
                    parts.push(`  ${index + 1}. ${item.type} "${item.title}" (${item.id})`);
                });
            }
        }

        // 3. Details item - The item whose details are being displayed in the details panels
        //    (less important than explicit selection, but still relevant context)
        if (ctx.detailsItem) {
            const prefix = ctx.selectedItems && ctx.selectedItems.find((item: any) => item.id === ctx.detailsItem.id)
                ? 'Also viewing details for'
                : 'Viewing details for';
            parts.push(`${prefix}: ${ctx.detailsItem.type} "${ctx.detailsItem.title}" (${ctx.detailsItem.id})`);
        }

        return parts.length > 0 ? `\n\nUser's Current Context:\n${parts.join('\n')}` : '';
    };

    private async executePlan(task: Task, availableTools: any[], latestPrompt: string): Promise<string> {
        let maxTurns = 20; // Starting limit
        let extensionsUsed = 0; 
        const maxExtensions = 2; // Allow up to two +10 extensions (max 40 turns total)
        let consecutiveFailures = 0;
        let useAdvancedModel = false;

        for (let i = 0; i < maxTurns; i++) {
            const preparedHistory = prepareHistoryForModel(task.history);

            this.emit('progress', {
                isLog: false,
                message: i === 0 ? 'Generating response...' : 'Planning next step...'
            });

            const { planSteps: nextSteps, modelResponseContent } = await determineNextStep(
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

                        return await summarizeFailureState(preparedHistory, latestPrompt);
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

                // If making good progress and we haven't maxed out extensions
                if (assessment.isMakingProgress && extensionsUsed < maxExtensions) {
                    this.emit('progress', { isLog: true, message: `Agent is making solid progress. Extending allowance by 10 turns...` });
                    maxTurns += 10; // Dynamically expands the for-loop!
                    extensionsUsed++;
                    continue;
                }

                // If NOT making progress, OR if we already extended and still hit the new limit, ask the user.
                this.emit('progress', { isLog: true, message: `Pausing for user permission.` });

                // Push dummy finish to close the function call array cleanly
                task.history.push({
                    role: 'function',
                    parts: [{ functionResponse: { name: 'finish', response: { status: 'paused' } } }]
                });

                return assessment.userMessage; 
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
            const isErrorResult = step.result && (step.result.type === 'Error' || step.result.ErrorCode || step.result.error);

            if (isErrorResult) {
                step.status = 'failed';
                step.error = step.result.Message || step.result.error || "Unknown tool error";
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
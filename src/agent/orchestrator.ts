import http from 'node:http';
import { filterResponseData } from '../utils/responseFiltering.js';
import { Task, PlanStep, MessageEmitter, Content } from './types.js';
import { selectRelevantTools, generatePlan, summarizeToolOutput } from './gemini.js';
import { READ_ONLY_TOOLS } from './readOnlyTools.js';

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
        const selectedTools = await selectRelevantTools(prompt, this.allTools);
        const plan = await generatePlan(prompt, contextItemId, history, selectedTools);

        // --- NEW: Conditional Plan Emission Logic ---
        const isSingleStep = plan.length === 1;
        const firstStepTool = plan[0]?.tool;
        // A step is considered safe to defer if it's a single, read-only action.
        const isSafeToDefer = isSingleStep && firstStepTool && READ_ONLY_TOOLS.includes(firstStepTool);
        let planEmitted = false;

        // If the plan is NOT safe to defer, emit it immediately.
        if (!isSafeToDefer) {
            this.emit('plan', { plan });
            planEmitted = true;
        }
        // --- End of New Logic ---

        const task: Task = {
            id: 'task-' + Date.now(),
            originalPrompt: prompt,
            plan: plan,
            currentStep: 0,
            contextItemId: contextItemId,
            history: history,
            shouldInvalidateContext: false,
        };

        task.history.push({ role: 'user', parts: [{ text: prompt }] });

        try {
            while (task.currentStep < task.plan.length) {
                const step = task.plan[task.currentStep];
                await this.executeStep(step, task);
                task.currentStep++;
            }

            const lastStep = task.plan[task.plan.length - 1];
            let finalMessage = "Task completed successfully.";

            if (lastStep?.status === 'completed' && lastStep.result) {
                const toolOutput = lastStep.result.content?.[0]?.text || lastStep.result;
                const summary = await summarizeToolOutput(toolOutput, task.originalPrompt);
                if (summary) {
                    finalMessage = summary;
                }
            }

            this.emit('result', {
                message: finalMessage,
                history: task.history,
                shouldInvalidateContext: task.shouldInvalidateContext
            });

        } catch (error) {
            // If the plan was deferred and an error occurred, emit the plan now for context.
            if (!planEmitted) {
                this.emit('plan', { plan });
            }
            // The error is already emitted by executeStep, and the exception stops further processing.
        }
    }

    private async executeStep(step: PlanStep, task: Task) {
        step.status = 'in-progress';
        this.emit('progress', { message: `Starting step ${step.step}: ${step.description}`, step: step.step });

        try {
            const toolToExecute = this.allTools.find(t => t.name === step.tool);
            if (!toolToExecute) throw new Error(`Tool '${step.tool}' not found.`);

            const args = this.substituteVariables(step.args, task);
            const result = await toolToExecute.execute(args, { request: this.req });

            step.status = 'completed';
            step.result = result;
            this.handleToolResult(result, step, task);
            
            // These now correctly match the 'Content' type
            task.history.push({ role: 'model', parts: [{ functionCall: { name: step.tool, args } }] });
            task.history.push({ role: 'tool', parts: [{ functionResponse: { name: step.tool, response: result } }] });

        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            step.status = 'failed';
            step.error = error.message;
            this.emit('error', { message: `Step ${step.step} failed: ${error.message}`, step: step.step });
            throw error;
        }
    }

    private substituteVariables(args: any, task: Task): any {
        if (!args) return {};
        let argString = JSON.stringify(args);
        
        argString = argString.replace(/\${(.*?)}/g, (match, variablePath) => {
            const [variableName, ...pathParts] = variablePath.split('.');
            
            const sourceStep = task.plan.find(p => p.outputVariable === variableName);
            if (!sourceStep || sourceStep.status !== 'completed' || !sourceStep.result) {
                console.warn(`[Orchestrator] Could not find completed step for variable: \${${variableName}}`);
                return "null";
            }

            let value = sourceStep.result;
            try {
                for (const part of pathParts) {
                    if (value === null || typeof value !== 'object') throw new Error(`Path part "${part}" is not valid.`);
                    value = value[part];
                }
                return JSON.stringify(value);
            } catch (e) {
                console.warn(`[Orchestrator] Error resolving path "${variablePath}":`, e);
                return "null";
            }
        });

        return JSON.parse(argString, (key, value) => {
            if (typeof value === 'string') {
                try { return JSON.parse(value); } catch (e) { /* not a JSON string */ }
            }
            return value;
        });
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

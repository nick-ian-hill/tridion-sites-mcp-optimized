/**
 * Represents the overall state of a multi-step task managed by the orchestrator.
 */
export interface Task {
    id: string;
    originalPrompt: string;
    plan: PlanStep[];
    currentStep: number;
    contextItemId?: string;
    history: Content[];
    shouldInvalidateContext: boolean;
}

/**
 * Represents a single, executable step within a task's plan.
 */
export interface PlanStep {
    step: number;
    description: string;
    tool: string;
    args: any;
    status: 'pending' | 'in-progress' | 'completed' | 'failed';
    result?: any;
    error?: string;
    outputVariable?: string;
}

/**
 * Defines the structure for events emitted by the orchestrator to the client.
 */
export interface OrchestratorEvent {
    type: 'plan' | 'progress' | 'result' | 'error' | 'ui-action';
    data: any;
}

/**
 * A function signature for emitting events from the orchestrator.
 */
export type MessageEmitter = (event: OrchestratorEvent['type'], data: OrchestratorEvent['data']) => void;

// These types accurately represent the Gemini conversation history structure.
export interface TextPart { text: string; }
export interface FunctionCallPart { functionCall: { name: string; args: any; }; }
export interface FunctionResponsePart { functionResponse: { name: string; response: any; }; }

export type ContentPart = TextPart | FunctionCallPart | FunctionResponsePart;

export interface Content {
    role: 'user' | 'model' | 'function';
    parts: ContentPart[];
}

/**
 * Context information from the UI about the user's current view.
 */
export interface AgentContext {
    /**
     * The item being displayed in the details panel.
     */
    detailsItem?: {
        id: string;
        type: string;
        title: string;
    };
    /**
     * Items selected in the table.
     */
    selectedItems?: Array<{
        id: string;
        type: string;
        title: string;
    }>;
    /**
     * The container item being viewed (e.g., Folder, StructureGroup, Category, Keyword, Bundle, SearchFolder, etc.).
     */
    container?: {
        id: string;
        type: string;
        title: string;
    };
}

/**
 * Represents the overall state of a multi-step task managed by the orchestrator.
 */
export interface Task {
    id: string;
    originalPrompt: string;
    plan: PlanStep[];
    currentStep: number;
    context?: AgentContext;
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
    type: 'plan' | 'progress' | 'result' | 'error' | 'ui-action' | 'completed';
    data: any;
}

/**
 * A function signature for emitting events from the orchestrator.
 */
export type MessageEmitter = (event: OrchestratorEvent['type'], data: OrchestratorEvent['data']) => void;

// These types accurately represent the Gemini conversation history structure.
export interface TextPart { text: string; thoughtSignature?: string; }
export interface FunctionCallPart { functionCall: { name: string; args: any; }; thoughtSignature?: string; }
export interface FunctionResponsePart { functionResponse: { name: string; response: any; }; }

export type ContentPart = TextPart | FunctionCallPart | FunctionResponsePart;

export interface Content {
    role: 'user' | 'model' | 'function';
    parts: ContentPart[];
}

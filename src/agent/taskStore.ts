import { OrchestratorEvent } from './types.js';

// A type for the state of a single, ongoing chat task.
export interface TaskState {
    id: string;
    isComplete: boolean;
    // A queue of events for the client to poll.
    events: OrchestratorEvent[];
    // A list of resolver functions for pending poll requests.
    pendingPolls: ((events: OrchestratorEvent[]) => void)[];
    lastAccessed: number;
}

// In-memory store for ongoing tasks. For production, this could be replaced with Redis or another persistent store.
const tasks = new Map<string, TaskState>();
const TASK_CLEANUP_INTERVAL = 60 * 1000; // 1 minute
const TASK_TIMEOUT = 10 * 60 * 1000; // 10 minutes

/**
 * Creates a new task in the store.
 */
export function createTask(taskId: string): void {
    tasks.set(taskId, {
        id: taskId,
        isComplete: false,
        events: [],
        pendingPolls: [],
        lastAccessed: Date.now(),
    });
}

/**
 * Adds a new event to a task's queue and resolves any pending polls.
 */
export function addTaskEvent(taskId: string, event: OrchestratorEvent): void {
    const task = tasks.get(taskId);
    if (!task) return;

    // If the task is finished, mark it as complete.
    if (event.type === 'result' || event.type === 'error') {
        task.isComplete = true;
    }

    // If there are pending poll requests waiting for data, resolve them immediately.
    if (task.pendingPolls.length > 0) {
        // Give the new event to all waiting polls.
        task.pendingPolls.forEach(resolve => resolve([event]));
        task.pendingPolls = []; // Clear the pending polls
    } else {
        // Otherwise, add the event to the queue for the next poll request.
        task.events.push(event);
    }
}

/**
 * Fetches events for a task. If no events are available, it waits for a new event or times out.
 */
export function getTaskEvents(taskId: string): Promise<OrchestratorEvent[]> {
    const task = tasks.get(taskId);
    if (!task) {
        return Promise.resolve([{ type: 'error', data: { message: 'Task not found or has expired.' } }]);
    }

    task.lastAccessed = Date.now();

    // If events are already in the queue, return them immediately.
    if (task.events.length > 0) {
        const events = [...task.events];
        task.events = []; // Clear the queue
        return Promise.resolve(events);
    }

    // If the task is already complete and the queue is empty, return an explicit 'completed' event.
    if (task.isComplete) {
        return Promise.resolve([{ type: 'completed', data: {} }]);
    }

    // Otherwise, wait for a new event to arrive.
    return new Promise(resolve => {
        const pollTimeout = setTimeout(() => {
            // If the timeout is reached, remove the resolver and return an empty array.
            const index = task.pendingPolls.indexOf(resolve);
            if (index > -1) {
                task.pendingPolls.splice(index, 1);
            }
            resolve([]);
        }, 25000); // 25-second timeout

        const resolver = (events: OrchestratorEvent[]) => {
            clearTimeout(pollTimeout);
            resolve(events);
        };
        task.pendingPolls.push(resolver);
    });
}

/**
 * Periodically cleans up old, completed tasks from memory.
 */
function cleanupOldTasks() {
    const now = Date.now();
    for (const [taskId, task] of tasks.entries()) {
        if (now - task.lastAccessed > TASK_TIMEOUT) {
            tasks.delete(taskId);
            console.log(`[TaskStore] Cleaned up expired task: ${taskId}`);
        }
    }
}

setInterval(cleanupOldTasks, TASK_CLEANUP_INTERVAL);
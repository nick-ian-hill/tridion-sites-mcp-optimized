# Tridion Sites Agent API

The `agent/` directory implements a Gemini-powered MCP client that web applications can use to interact with the Tridion Sites CMS through natural language. It sits between a web UI and the MCP server, managing multi-step task execution, conversation history, and UI-directed actions.

```
Web Application  ──POST /agent/chat──►  Agent API  ──►  Orchestrator  ──►  MCP Tools  ──►  CMS
     │                                                                                         
     └──POST /agent/poll-updates──►  Task Store  (long-polling for events)
```

---

## Prerequisites

In addition to the standard MCP server environment variables, the agent requires a **Gemini API key**:

```env
GEMINI_API_KEY=<your-gemini-api-key>
```

Obtain one from [Google AI Studio](https://aistudio.google.com/). The agent uses the `@google/genai` SDK and will throw an error on the first request if this variable is not set.

An **API key** is also required on every request to authenticate the web application against the agent endpoints:

```env
MCP_API_KEY=<your-chosen-api-key>
```

If `MCP_API_KEY` is not set, the server defaults to `demo-secret-key`. Pass this value in the `X-Api-Key` header on every request.

---

## Endpoints

All three endpoints are served by the same `npm run start` process on port 8090.

### `POST /agent/chat`

Starts a new agent task. The orchestrator runs asynchronously in the background and the endpoint returns immediately with a `taskId` for polling.

**Request body:**

```json
{
  "prompt": "Create a new component called 'Hero Banner' in folder tcm:1-10",
  "history": [],
  "context": {
    "container": { "id": "tcm:1-10", "type": "Folder", "title": "Components" },
    "selectedItems": [{ "id": "tcm:1-20", "type": "Component", "title": "My Component" }],
    "detailsItem": { "id": "tcm:1-20", "type": "Component", "title": "My Component" }
  },
  "attachments": [
    { "tempFileId": "abc-123", "fileName": "brief.docx" }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | Yes | The user's natural language instruction |
| `history` | array | No | Prior conversation turns (Gemini `Content[]` format). Pass the `history` returned by a previous `result` event to maintain conversation context across turns |
| `context` | object | No | The user's current UI context — see [AgentContext](#agentcontext) below |
| `attachments` | array | No | Files uploaded by the user. Each entry has a `tempFileId` (returned by a separate file upload endpoint) and a `fileName` |

**Response:**

```json
{ "taskId": "550e8400-e29b-41d4-a716-446655440000" }
```

---

### `POST /agent/poll-updates`

Long-polls for new events from a running task. The server holds the connection open until at least one new event is available (up to ~30 seconds), then returns. The client should call this endpoint in a loop until a `result` or `error` event is received.

**Request body:**

```json
{ "taskId": "550e8400-e29b-41d4-a716-446655440000" }
```

**Response:**

```json
{
  "events": [
    { "type": "progress", "data": { "isLog": true, "message": "Calling tool: getItem..." } },
    { "type": "plan", "data": { "plan": [ ... ] } }
  ]
}
```

---

### `POST /agent/tools/orchestrator`

Executes a `toolOrchestrator` script directly, bypassing the LLM. Useful for deterministic, pre-written multi-step workflows triggered from the UI without natural language input. Returns clean JSON rather than the MCP content envelope.

**Request body:** The same input accepted by the `toolOrchestrator` MCP tool.

**Response:** The unwrapped JSON result of the script execution.

---

## Event Types

The poll endpoint returns an array of events. Process them in order.

| `type` | When emitted | `data` shape |
|---|---|---|
| `progress` | Each time the orchestrator calls a tool or logs a status message | `{ message: string, isLog?: boolean }` |
| `plan` | After the model decides on a plan | `{ plan: PlanStep[] }` |
| `result` | Task completed successfully — **stop polling** | `{ message: string, history: Content[], shouldInvalidateContext: boolean }` |
| `error` | Task failed — **stop polling** | `{ message: string }` |
| `ui-action` | The model wants the UI to perform a navigation or UI change — see [UI Actions](#ui-actions) | `{ action: { type: string, payload: object } }` |

A task is complete when you receive a `result` or `error` event. Tasks are kept in memory for 10 minutes after their last access and then cleaned up automatically.

---

## AgentContext

Passing `context` with each request lets the model understand what the user is currently looking at in the UI, which allows it to infer item IDs without the user having to specify them explicitly.

```ts
interface AgentContext {
  container?: {
    id: string;      // TCM URI, e.g. "tcm:1-10-2", or a UI-fabricated ID for virtual nodes
    type: string;    // e.g. "Folder", "StructureGroup", "SearchFolder"
    title: string;
    isVirtualNode?: boolean; // true for UI-only nodes whose IDs cannot be used in API calls
  };
  selectedItems?: Array<{
    id: string;
    type: string;
    title: string;
  }>;
  detailsItem?: {
    id: string;
    type: string;
    title: string;
  };
}
```

The model receives context fields in priority order: **container** (where the user is browsing) → **selectedItems** (checked items) → **detailsItem** (item open in the details panel). Virtual nodes (e.g. "Favourites") are flagged so the model knows their IDs are not valid for CMS API calls.

---

## UI Actions

When the model uses one of the UI-specific tools, the event stream will contain a `ui-action` event instead of a regular result. The web application is responsible for handling these actions:

| `action.type` | Tool | What the UI should do |
|---|---|---|
| `navigate` | `requestNavigation` | Navigate the content tree to `payload.itemId`. If `payload.navigateInto` is `true`, browse into the container rather than just selecting it |
| `openInEditor` | `requestOpenInEditor` | Open the item at `payload.itemId` in its editor view |

These tools are only available when `ENABLE_UI_ASSISTANT_TOOLS` is `true` in `index.ts` (the default).

---

## Polling Flow Example

```
Client                                     Server
  │                                           │
  ├─ POST /agent/chat { prompt, context } ───►│  Creates task, starts orchestrator async
  │◄─ { taskId } ─────────────────────────────┤
  │                                           │
  ├─ POST /agent/poll-updates { taskId } ────►│  No events yet — holds connection open
  │◄─ { events: [{ type:'progress', ... }] } ─┤  Resolves when first event arrives
  │                                           │
  ├─ POST /agent/poll-updates { taskId } ────►│  Holds until next event
  │◄─ { events: [{ type:'plan', ... }] } ─────┤
  │                                           │
  ├─ POST /agent/poll-updates { taskId } ────►│
  │◄─ { events: [{ type:'result', ... }] } ───┤  Task complete — stop polling
  │                                           │
```

Pass the `history` array from the `result` event back as the `history` field in the next `/agent/chat` request to continue the conversation with full context.

---

## In-Memory Task Store

Tasks and their event queues are held in process memory. This means:

- **Tasks are lost on server restart.** Any in-flight poll requests will hang until timeout.
- **Tasks expire** after 10 minutes of inactivity and are cleaned up automatically.
- For production deployments handling concurrent users, consider replacing the in-memory store in `taskStore.ts` with a persistent solution such as Redis (as noted in the source comments).

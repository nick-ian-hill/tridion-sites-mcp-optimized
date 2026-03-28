# Tridion Sites MCP Server

This repository contains a Model Context Protocol (MCP) server designed to integrate Tridion Sites with AI assistants like GitHub Copilot and Gemini. By running this server locally, you enable your AI assistant to securely interact with the Tridion Sites Content Management (CM) REST API, providing context-aware completions, tool executions, and content generation.

## Capabilities

This server exposes over 80 tools covering all major areas of Tridion Sites content management. The table below summarises what the AI assistant can do on your behalf once connected.

| Domain | Available Operations |
|---|---|
| **Content Discovery** | Search items; retrieve full item details and version history; browse container contents; inspect dependency graphs, publish info, and lock status |
| **Content Creation** | Create components, pages, publications, structure groups, and multimedia components (from a URL, base64 data, file attachment, or an AI-generated prompt) |
| **Content Editing** | Update component content, page layouts, item properties, metadata, and publication settings |
| **Content Organization** | Copy or move items between containers within a publication; delete items or specific historical versions |
| **Schema Management** | Create and modify component, embedded, metadata, bundle, multimedia, and region schemas |
| **Version Control** | Check out / in items, undo checkouts, and roll back to prior versions |
| **Publishing** | Publish and unpublish items to configured targets; monitor and query publish transactions |
| **Workflow** | Start, assign, finish, and restart individual workflow activities; force-finish or revert entire workflow process instances; manage process definitions and approval statuses |
| **Taxonomy & Classification** | Classify items with keywords, browse category trees, and auto-classify items or multimedia components using AI |
| **BluePrint & Localization** | Visualize and create BluePrint hierarchies; localize and unlocalize items; promote and demote items to parent or child publications |
| **Multimedia** | Read binary content and split Word / PowerPoint documents into structured components and images |
| **User Management** | Retrieve and update user profiles; list CMS users |
| **AI-Powered Generation** | Generate component content, create or update multimedia from natural language prompts *(requires a configured Gemini API key)* |
| **Orchestration** | Execute complex multi-step operations via the `toolOrchestrator`, which runs sandboxed scripts with access to all other tools — enabling conditional logic, loops, and batch processing |

---

## Prerequisites

Before running the server, ensure you have the following installed:
* [Node.js](https://nodejs.org/) and npm
* Access to a Tridion Sites CMS instance

---

## 1. Local Server Setup

To get the MCP server running on your machine, follow these steps:

1. **Download/Clone the repository:** Ensure you have the latest version of the codebase on your local machine.
   ```bash
   git clone <your-repository-url>
   cd <your-repository-directory>
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Obtain Service Account Credentials:**
   To authenticate the server against the CM REST API, you need a valid Client ID and Secret.
   * Log in to your Tridion Sites **Access Management** console.
   * Navigate to the **Service accounts** tab.
   * Locate and click on the relevant service account for your environment (e.g., **Tridion Sites Content Manager API Client (admin)**).
   * From the details screen, copy your **Client ID** and generate/copy your **Client Secret**.

4. **Configure Environment Variables:**
   Set the following environment variables using the credentials you just obtained.
   *(Note: The URLs below are examples and should be updated to match your target CMS environment).*

   ```env
   CORE_API_URL=http://10.100.92.199:81/api/v3.0
   AUTH_TOKEN_URL=http://external-dxui-dev-sites-stg.ted.nl.sdldev.net/access-management/connect/token
   AUTH_CLIENT_ID=<your-client-id>
   AUTH_CLIENT_SECRET=<your-client-secret>
   GEMINI_API_KEY=<your-gemini-api-key>
   ```

   > **Note on `GEMINI_API_KEY`:** This key is only required if you intend to use the AI-powered tools (`autoClassifyItem`, `autoClassifyMultimediaComponent`, `generateContentFromPrompt`, `createMultimediaComponentFromPrompt`, `updateMultimediaComponentFromPrompt`) or the built-in agent API. It is also required by `readMultimediaComponent` and `readUploadedFile` when reading **image** files (the vision model is used to analyse the image content; non-image formats such as Word, Excel, and PDF do not require the key). All other tools work without it. Obtain a key from [Google AI Studio](https://aistudio.google.com/).

   > **Windows tip:** To set variables persistently (so they survive terminal sessions and reboots), use **System Properties** instead of setting them in the terminal:
   > 1. Open **Start**, search for **"Edit the system environment variables"**, and open it.
   > 2. Click **Environment Variables…** and add each variable under **User variables**.
   > 3. Click **OK** on all dialogs, then open a **new terminal** before continuing.
   >
   > Alternatively, set them temporarily in PowerShell for the current session:
   > ```powershell
   > $env:CORE_API_URL = "http://..."
   > $env:AUTH_TOKEN_URL = "http://..."
   > $env:AUTH_CLIENT_ID = "<your-client-id>"
   > $env:AUTH_CLIENT_SECRET = "<your-client-secret>"
   > ```

5. **Start the server:**
   ```bash
   npm run start
   ```
   *The server will start and listen locally on port 8090. No separate build or compile step is required — the server runs TypeScript directly using `tsx`.*

---

## 2. Project Structure

```
src/
├── index.ts              # HTTP server entry point. Dynamically loads all tools from tools/,
│                         # registers them with the MCP server, and exposes the agent API endpoints.
├── tools/                # One file per MCP tool. Each file exports a single object with a name,
│                         # description, Zod input schema, and an execute function.
├── schemas/              # Reusable Zod schemas shared across multiple tools (e.g. search query
│                         # parameters, link structures, field value shapes, XML name rules).
├── utils/                # Shared helper modules used by tools:
│   ├── axios.ts          # Authenticated Axios instance. Handles OAuth token acquisition and
│   │                     # caching, and injects the correct Authorization header on every request.
│   ├── errorUtils.ts     # Standardises error responses returned from tool execute functions.
│   ├── responseFiltering.ts  # Trims large CMS responses to keep LLM context usage low.
│   └── ...               # Other helpers for page layout, link resolution, language handling, etc.
└── agent/                # Gemini-powered MCP client for web applications. Provides an async
                          # chat API with long-polling. See src/agent/README.md for details.
```

---

## 3. Usage with GitHub Copilot (VS Code)

To use the MCP server as context for testing inside VS Code, follow these steps:

1. **Create a workspace:** Create a new folder on your machine that you want to use as the context for testing, and open this folder in VS Code.
2. **Create the MCP configuration:**
   * Inside this folder, create a `.vscode` directory.
   * Inside the `.vscode` directory, create a file named `mcp.json`.
3. **Add the server reference:** Paste the following configuration into `mcp.json` to point VS Code to your local MCP server:
   ```json
   {
     "servers": {
       "tridion-sites-mcp-server": {
         "url": "http://localhost:8090"
       }
     }
   }
   ```
4. **Connect VS Code to the server:** Open the `mcp.json` file in VS Code. You will see a UI overlay (CodeLens) above the `"tridion-sites-mcp-server"` line. Click **Start** to connect VS Code to your already-running local server. Note that this button only establishes the connection — it does not start the HTTP server itself. `npm run start` must already be running before you click it.
5. **Open Chat:** Go to **View > Chat** in the VS Code menu to open the agent chat window.
6. **Ask Questions:** From the chat window, you can select your preferred model (e.g., Gemini Pro) from the dropdown and start submitting prompts. The assistant will now route relevant Tridion Sites queries through your local MCP server.

---

## 4. Usage with Gemini CLI/Environment

If you are running the MCP server directly with a Gemini environment, you must configure your settings file to register the server and exclude specific tools if necessary.

1. **Locate your settings file:** Find your Gemini settings configuration (for example, `C:\ProgramData\gemini-cli\settings.json` on Windows).
2. **Update the `mcpServers` block:** Add the following configuration. This points Gemini to your local server and explicitly excludes tools that you may not want the model to access in this context:
   ```json
   {
     "mcpServers": {
       "tridion-sites-mcp-server": {
         "httpUrl": "http://localhost:8090",
         "excludeTools": [
           "autoClassifyItem",
           "autoClassifyMultimediaComponent",
           "generateContentFromPrompt",
           "createMultimediaComponentFromPrompt",
           "readMultimediaComponent",
           "readUploadedFile",
           "updateMultimediaComponentFromPrompt"
         ]
       }
     }
   }
   ```
3. **Restart your Gemini interface:** Save the file and restart your Gemini application. It will connect to `localhost:8090` and utilize the available tools.

---

## 5. Troubleshooting

### The AI Assistant returns an `invalid_client` authentication error
If the MCP server is running but the assistant reports that calls to the CMS are failing with an `invalid_client` error, the Tridion authentication server is rejecting your credentials. Check the following:

1. **VS Code Stale Terminals (Most Common):** If you recently set or updated your environment variables locally, **any currently open VS Code terminals will not see the new values**. 
   * **Fix:** You must completely kill the terminal session by clicking the **Trash Can icon** in the terminal panel, open a new terminal, and run `npm run start` again.
   * **Verify:** In your new VS Code terminal, you can verify the variable was picked up by running:
     * *PowerShell:* `echo $env:AUTH_CLIENT_ID`
     * *Bash/Zsh:* `echo $AUTH_CLIENT_ID`

2. **Old or Revoked Credentials:** Ensure you are using the correct secret for the specific environment URL (`AUTH_TOKEN_URL`) you are targeting. If you are copying a secret shared by a colleague, it may have been regenerated or revoked in Access Management. Generate a fresh secret if necessary.

---

### The server fails to start: `EADDRINUSE` (port already in use)

If `npm run start` exits immediately with an `EADDRINUSE` error, another process is already using port 8090 (often a previous server instance that was not cleanly stopped).

* **Kill the conflicting process** (PowerShell):
  ```powershell
  Get-Process -Id (Get-NetTCPConnection -LocalPort 8090).OwningProcess | Stop-Process
  ```
* Then re-run `npm run start`.

---

### The AI assistant reports it cannot reach the CMS (network/timeout errors)

1. Confirm the CMS is reachable from your machine by opening `CORE_API_URL` in a browser or running:
   ```powershell
   Invoke-WebRequest -Uri $env:CORE_API_URL -UseBasicParsing
   ```
2. Check that no VPN, firewall, or proxy is blocking outbound HTTP requests to the CMS host.
3. If you are targeting a CMS on a private network, ensure your machine is connected to the appropriate VPN or internal network.

---

### Tools are missing or not visible in the AI assistant

* **GitHub Copilot:** The connection is established automatically when you ask a question that requires the MCP tools — no manual action is needed. If the tools are still not available, open the `mcp.json` file and click **Restart** in the CodeLens overlay. Note that this button only reconnects VS Code to the server; which must already be running (`npm run start`) for it to succeed.
* **Gemini CLI:** After saving changes to `settings.json`, restart the Gemini application completely. Run `/mcp list` in the chat to confirm the server is connected.

---

### Gemini CLI shows the MCP server as "disconnected"

Gemini CLI attempts to connect to all configured MCP servers **once at startup**. If the server was not running at the time the CLI was launched, the connection fails for that session.

**Fix:** Start `npm run start` first and then launch Gemini CLI, or — if the CLI is already open — start the server and then run `/mcp reload` in the Gemini CLI chat to reconnect without restarting.
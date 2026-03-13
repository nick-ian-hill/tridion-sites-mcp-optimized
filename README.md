# Tridion Sites MCP Server

This repository contains a Model Context Protocol (MCP) server designed to integrate Tridion Sites with AI assistants like GitHub Copilot and Gemini. By running this server locally, you enable your AI assistant to securely interact with the Tridion Sites Content Management (CM) REST API, providing context-aware completions, tool executions, and content generation.

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
   ```

5. **Start the server:**
   ```bash
   npm run start
   ```
   *The server will start and listen locally on port 8090.*

---

## 2. Usage with GitHub Copilot (VS Code)

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
4. **Start the connection:** Open the `mcp.json` file in VS Code. You will see a UI overlay (CodeLens) above the `"tridion-sites-mcp-server"` line with options like `Running | Stop | Restart`. Click **Start** to connect.
5. **Open Chat:** Go to **View > Chat** in the VS Code menu to open the agent chat window.
6. **Ask Questions:** From the chat window, you can select your preferred model (e.g., Gemini Pro) from the dropdown and start submitting prompts. The assistant will now route relevant Tridion Sites queries through your local MCP server.

---

## 3. Usage with Gemini CLI/Environment

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

## 4. Troubleshooting

### The AI Assistant returns an `invalid_client` authentication error
If the MCP server is running but the assistant reports that calls to the CMS are failing with an `invalid_client` error, the Tridion authentication server is rejecting your credentials. Check the following:

1. **VS Code Stale Terminals (Most Common):** If you recently set or updated your environment variables locally, **any currently open VS Code terminals will not see the new values**. 
   * **Fix:** You must completely kill the terminal session by clicking the **Trash Can icon** in the terminal panel, open a new terminal, and run `npm run start` again.
   * **Verify:** In your new VS Code terminal, you can verify the variable was picked up by running:
     * *PowerShell:* `echo $env:AUTH_CLIENT_ID`
     * *Bash/Zsh:* `echo $AUTH_CLIENT_ID`

2. **Old or Revoked Credentials:** Ensure you are using the correct secret for the specific environment URL (`AUTH_TOKEN_URL`) you are targeting. If you are copying a secret shared by a colleague, it may have been regenerated or revoked in Access Management. Generate a fresh secret if necessary.
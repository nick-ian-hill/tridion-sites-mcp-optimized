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

3. **Configure Environment Variables:**
   The server requires the following environment variables to authenticate against the CM REST API. 
   *(Note: The values below are specific to a particular CMS instance and should be updated to match your target environment).*

   ```env
   CORE_API_URL=http://10.100.92.199:81/api/v3.0
   AUTH_TOKEN_URL=http://external-dxui-dev-sites-stg.ted.nl.sdldev.net/access-management/connect/token
   AUTH_CLIENT_ID=78ffaefc-cd0e-4d12-90bf-c6be42cd7a10
   AUTH_CLIENT_SECRET=l2J8vixf0NMHqcldUH3BM/vULPQaVQhx8gF9u7hrXZYhq3IQUEy9nQ==
   ```

4. **Start the server:**
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
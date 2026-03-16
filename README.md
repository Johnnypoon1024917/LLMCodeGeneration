# NexusCode: Autonomous AI Coding Assistant

NexusCode is a powerful, autonomous AI programming assistant for Visual Studio Code. It acts as a pair programmer capable of understanding your entire project context, executing surgical code injections, and even evolving its own codebase.

## 🚀 Features

- **Surgical AST Code Injection:** Powered by Tree-Sitter, NexusCode doesn't just append text; it mathematically analyzes your code's Abstract Syntax Tree to inject methods and properties exactly where they belong without breaking syntax.
- **Atomic File Edits:** AI-generated implementation plans are broken down into single-file, atomic steps. Review, accept, or reject changes on a per-file basis using the native CodeLens UI.
- **Context-Aware Generation:** NexusCode automatically scans your workspace and reads your `.eslintrc` and `tsconfig.json` to ensure generated code matches your project's strict styling rules.
- **Auto-Healing Tests:** If generated tests fail, the AI automatically reads the terminal error output and attempts to fix the logic before you even have to look at it.
- **Meta-Mode (Self-Evolution):** NexusCode is capable of reading and modifying its own extension source code, allowing it to build new features for itself.

## ⚙️ Configuration

NexusCode can be connected to any OpenAI-compatible API endpoint (including local LLMs via LM Studio or vLLM). 

Access these settings in VS Code via `Preferences: Open Settings (UI)` -> search for `NexusCode`:

* `nexuscode.apiEndpoint`: The URL of your LLM provider (Default: `http://127.0.0.1:1234/v1/chat/completions`).
* `nexuscode.model`: The name or path of the model to use (Default: `qwen-72b`).
* `nexuscode.apiKey`: Your API Key (if using a cloud provider or authenticated gateway).
* `nexuscode.enableTools`: Enable agent tools for autonomous repository exploration.

## 🛠️ Usage

1. Open the **NexusCode** sidebar from the Activity Bar.
2. Type a natural language request (e.g., *"Create a new AuthGuard component and write tests for it"*).
3. Review the AI's generated implementation plan.
4. Click **Execute All** or run tasks individually.
5. Review the purple highlighted code changes in your editor and click **Accept** or **Reject** from the floating lens above the code.

## 📝 Requirements

* Visual Studio Code v1.80.0 or higher.
* Node.js and NPM (for workspace command execution and auto-healing).

## 🔒 Security & Privacy

NexusCode is designed to work with local, privacy-first LLMs. When using endpoints like LM Studio or Ollama, your codebase never leaves your local machine.
// src/llm/toolSchemaInjection.ts
//
// Renders a ToolDefinition[] array into a system-message addendum
// that teaches the model to emit `<tool_call>` text-format calls
// when the inference server's chat template doesn't bake the tool
// schemas into the prompt itself.
//
// Why this module exists:
//
// The OpenAI tool-calling protocol expects two things:
//   1. The request includes `tools: [...]` and `tool_choice: 'auto'`.
//   2. The server's chat template renders those tools into the
//      prompt's system message in a format the model recognizes,
//      OR the model is fine-tuned to recognize them when injected
//      via a special role.
//
// (1) is on us — and we already do it correctly. (2) is on the
// inference server's startup config (e.g. vLLM's `--chat-template`
// flag). When (2) is misconfigured, the model sees a request with
// "no tools", writes a tutorial in markdown, and our `tool_calls`
// field comes back empty.
//
// We can't tell our customers "configure your vLLM correctly." We
// own the user experience end-to-end. So when we detect this
// failure mode, we fall back to text-mode tool calling: render the
// tool schemas into the system message ourselves, instruct the
// model to emit calls in `<tool_call>{...}</tool_call>` format,
// and parse the response with `extractFallbackToolCalls`.
//
// This module is the request-side counterpart to
// `extractFallbackToolCalls` (the response-side parser).
//
// What this module is NOT:
//
//   - This is NOT applied unconditionally. Native tool-calling is
//     better when it works — fewer tokens spent on schema, model is
//     trained to format the call correctly, less risk of confusion.
//     This module is the fallback for endpoints we've detected as
//     unable to use native tools properly.
//
//   - This does NOT replace the request-body `tools` field. We send
//     both the schema-as-text (here) AND the `tools` array — the
//     latter remains a hint to any sufficiently-capable downstream
//     middleware. Belt and suspenders.

import type { ToolDefinition } from './Provider';

/**
 * Render a list of tool definitions into a system-message addendum
 * that teaches the model to call them in text format.
 *
 * The output is designed to be appended to an existing system prompt
 * (or used as the entire system message if no system prompt exists)
 * without conflicting with arbitrary task-specific instructions the
 * caller might have written.
 *
 * Format choice rationale:
 *
 *   - We use `<tool_call>...</tool_call>` (the Hermes / Qwen3 standard)
 *     because (a) `extractFallbackToolCalls` handles it as the first
 *     priority format, and (b) most models with any tool-call exposure
 *     have seen this format during training.
 *
 *   - We include a worked Hello-World example. Per the GitHub issue
 *     research that produced this fallback work, Qwen 2.5 Coder
 *     achieves ~100% format compliance with one-shot examples vs
 *     near-zero without them.
 *
 *   - We do NOT use markdown code fences inside the example, because
 *     some models then mirror that structure (emitting code-fenced
 *     tool calls), and our parser handles ```json fences as a
 *     separate format with lower priority — better to have the
 *     model emit the canonical format directly.
 *
 *   - Each tool schema is rendered as compact JSON (no pretty-print)
 *     to minimize prompt tokens. The tool schemas are typically the
 *     largest single contributor to system-prompt size in this mode.
 *
 * Empty input (no tools) returns an empty string — the caller should
 * not append anything in that case. Defensive on that path.
 */
export function renderToolSchemasAsSystemPrompt(
    tools: readonly ToolDefinition[]
): string {
    if (tools.length === 0) { return ''; }

    const lines: string[] = [];

    lines.push('# Tools available to you');
    lines.push('');
    lines.push(
        'You have access to the following tools. To use one, emit a tool ' +
        'call in the EXACT format shown below — your response runtime will ' +
        'parse it and execute the tool.'
    );
    lines.push('');
    lines.push('## Tool definitions');
    lines.push('');

    // Render each tool as a JSON object on its own line. We keep this
    // compact rather than pretty-printed because the tool list is the
    // bulk of the prompt overhead in this mode and small tools may be
    // many in number (Coder has ~5, future agents may have more).
    for (const tool of tools) {
        // Defensive — silently skip malformed entries rather than throw.
        // The caller (Coder/Planner/Verifier) shouldn't crash because of
        // a config glitch in tool registration.
        if (
            tool?.type !== 'function' ||
            typeof tool.function?.name !== 'string' ||
            typeof tool.function?.description !== 'string'
        ) { continue; }

        // We render `function` only (not the `type: 'function'` wrapper)
        // because the wrapper is OpenAI-protocol vestige; the model
        // doesn't need it to understand the tool. Saves a few tokens
        // per tool.
        const compact = JSON.stringify(tool.function);
        lines.push(compact);
    }

    lines.push('');
    lines.push('## Format for calling a tool');
    lines.push('');
    lines.push(
        'When you decide to call a tool, your response must contain a ' +
        '`<tool_call>` block with a complete JSON object. The JSON has ' +
        'two fields: `name` (the tool to call) and `arguments` (an ' +
        'object containing the tool\'s parameters as documented above).'
    );
    lines.push('');
    lines.push('Example — to call write_file with two arguments:');
    lines.push('');
    lines.push('<tool_call>');
    lines.push('{"name": "write_file", "arguments": {"path": "main.c", "content": "#include <stdio.h>\\n\\nint main() {\\n    printf(\\"Hello, World!\\\\n\\");\\n    return 0;\\n}\\n"}}');
    lines.push('</tool_call>');
    lines.push('');
    lines.push(
        'CRITICAL: emit the COMPLETE tool call. The opening `<tool_call>` tag, ' +
        'the full JSON, and the closing `</tool_call>` tag MUST all appear ' +
        'together in your response. Do not stop after just the opening tag. ' +
        'Do not write a tutorial or markdown explanation of how the tool works ' +
        '— call it.'
    );

    return lines.join('\n');
}

/**
 * Append the rendered tool-schema text to an existing system-message
 * content string. If the original system message is empty, the
 * rendered text becomes the entire system message.
 *
 * The caller is responsible for plumbing this back into the
 * `messages` array — this is a pure string transformation.
 */
export function appendToolSchemasToSystemPrompt(
    existingSystemContent: string,
    tools: readonly ToolDefinition[]
): string {
    const rendered = renderToolSchemasAsSystemPrompt(tools);
    if (rendered.length === 0) { return existingSystemContent; }

    if (existingSystemContent.length === 0) { return rendered; }

    // Two newlines to clearly separate the caller's task instructions
    // from the tool-schema addendum. Tool schemas land at the end so
    // the model first reads its task, then the tool format reminder.
    return `${existingSystemContent}\n\n${rendered}`;
}
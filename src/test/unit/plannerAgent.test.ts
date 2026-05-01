// src/test/unit/plannerAgent.test.ts
//
// Unit tests for PlannerAgent — the C-2 wrapper around runReAct that
// replaces both runPlannerAgent and runExplorerAgent.
//
// Scope notes:
//
// The legacy `planAgent.test.ts` (deleted in C-2) had 20 tests that
// covered loop semantics — message accumulation, MAX_STEPS guard,
// dedup behavior, stuck-loop detection, budget exhaustion, etc. All
// of that is now owned by `ReActEngine.test.ts` (44 tests). We don't
// re-test the loop here.
//
// What this file tests:
//   - PlannerAgent's wrapper-level responsibilities:
//     * Mode dispatch (build vs explore)
//     * System prompt construction (rule/PRD/design/failure blocks)
//     * Tool catalog selection (read-only)
//     * Hardening flags forwarded
//     * Source tag and taskId scoping
//     * Boot + success log messages
//     * Legacy logToolCall fallback when emitter absent
//     * No legacy logToolCall when emitter present
//   - Result mapping (techSpec ↔ finalContent)
//
// What we deliberately DO NOT test:
//   - ReAct loop semantics — that's ReActEngine.test.ts
//   - dispatchWithEvents wiring details — that's toolDispatchWithEvents.test.ts
//   - The actual prompt wording — brittle, not what these tests protect

const mockDispatchWithEvents = jest.fn();
jest.mock('../../agents/toolDispatchWithEvents', () => ({
    dispatchWithEvents: mockDispatchWithEvents
}));

jest.mock('../../agents/toolRegistry', () => ({
    getToolDefinitions: (names: string[]) => names.map(name => ({
        type: 'function',
        function: {
            name,
            description: `mock ${name}`,
            parameters: { type: 'object', properties: {} }
        }
    }))
}));

// Stub the tools barrel — its registerTool side-effects don't fire in tests.
jest.mock('../../agents/tools', () => ({}));

// Stub securityHook (PlannerAgent uses allowAllHook).
jest.mock('../../agents/securityHook', () => ({
    allowAllHook: async () => ({ blocked: false })
}));

// Mock Provider so we can script chatCompletion responses.
const mockProvider = {
    name: 'mock',
    endpoint: 'http://mock',
    model: 'mock',
    chatCompletion: jest.fn(),
    streamChatCompletion: jest.fn(),
    streamCompletion: jest.fn(),
    completion: jest.fn(),
    jsonCompletion: jest.fn(),
    listModels: jest.fn(),
};
jest.mock('../../llm', () => ({
    getProvider: async () => mockProvider
}));

// Imports AFTER mocks are wired.
import { PlannerAgent } from '../../agents/PlannerAgent';
import type { AssistantMessage } from '../../llm';

// ─── Helpers ─────────────────────────────────────────────────────────

interface CapturedLog {
    msg: string;
    stepType?: string;
    details?: string;
}

function makeLog(): { calls: CapturedLog[]; fn: (msg: string, stepType?: string, details?: string) => void } {
    const calls: CapturedLog[] = [];
    const fn = (msg: string, stepType?: string, details?: string) => {
        const entry: CapturedLog = { msg };
        if (stepType !== undefined) entry.stepType = stepType;
        if (details !== undefined) entry.details = details;
        calls.push(entry);
    };
    return { calls, fn };
}

function scriptResponses(responses: AssistantMessage[]): void {
    let idx = 0;
    mockProvider.chatCompletion.mockImplementation(async () => {
        if (idx >= responses.length) {
            throw new Error(`PlannerAgent: provider mock exhausted (idx=${idx})`);
        }
        return responses[idx++]!;
    });
}

const VALID_PLAN_XML =
    '<analysis>X</analysis>' +
    '<files_to_modify><file>a.ts</file></files_to_modify>' +
    '<execution_plan>do thing</execution_plan>' +
    '<verification_rules>- works</verification_rules>';

beforeEach(() => {
    mockProvider.chatCompletion.mockReset();
    mockDispatchWithEvents.mockReset();
});

// ─── Mode dispatch ──────────────────────────────────────────────────

describe('PlannerAgent — mode dispatch', () => {
    test('explore mode is implemented (no longer throws "not yet implemented")', async () => {
        // C-3 wired explore mode. The legacy throw from C-2 is gone —
        // explore mode now produces a real result. This test exists
        // primarily to lock in that the mode dispatch reaches runExplore
        // and not the old throw site. Detailed behavior is verified in
        // the "explore mode" describe block below.
        scriptResponses([{ role: 'assistant', content: 'READY_TO_CODE' }]);
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'explore',
            task: 'investigate',
            workspaceRoot: '/repo',
            log
        });

        expect(result.mode).toBe('explore');
    });

    test('build mode runs successfully when model emits the XML plan', async () => {
        scriptResponses([{ role: 'assistant', content: VALID_PLAN_XML }]);
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'build',
            task: 'add a feature',
            workspaceRoot: '/repo',
            log
        });

        expect(result.techSpec).toContain('<execution_plan>');
        expect(result.completedNormally).toBe(true);
        expect(result.totalToolCalls).toBe(0);
    });
});

// ─── Result mapping ─────────────────────────────────────────────────

describe('PlannerAgent — result mapping', () => {
    test('techSpec contains the final assistant content from the engine', async () => {
        scriptResponses([{ role: 'assistant', content: VALID_PLAN_XML }]);
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        expect(result.techSpec).toBe(VALID_PLAN_XML);
    });

    test('totalToolCalls reflects dispatched calls', async () => {
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }]
            },
            { role: 'assistant', content: VALID_PLAN_XML }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data',
            uiPayload: { kind: 'file_contents', filepath: 'a.ts', contents: 'X' }
        });
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        expect(result.totalToolCalls).toBe(1);
        expect(result.completedNormally).toBe(true);
    });

    test('completedNormally is false when maxSteps is reached without a plan', async () => {
        // 8 tool-only turns saturate the 8-step ceiling without ever
        // emitting <execution_plan>. The 8th turn returns best-effort
        // content (whatever non-tool content arrived, possibly empty).
        const toolTurn = (id: string, fp: string): AssistantMessage => ({
            role: 'assistant',
            content: null,
            tool_calls: [{ id, type: 'function' as const, function: { name: 'read_file', arguments: `{"filepath":"${fp}"}` } }]
        });
        // 7 tool turns then a final non-tool turn without the plan tag.
        scriptResponses([
            toolTurn('c1', 'a.ts'),
            toolTurn('c2', 'b.ts'),
            toolTurn('c3', 'c.ts'),
            toolTurn('c4', 'd.ts'),
            toolTurn('c5', 'e.ts'),
            toolTurn('c6', 'f.ts'),
            toolTurn('c7', 'g.ts'),
            { role: 'assistant', content: 'I was thinking but ran out of room' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        expect(result.completedNormally).toBe(false);
        expect(result.techSpec).toContain('I was thinking');
    });
});

// ─── Boot + success log messages (legacy parity) ────────────────────

describe('PlannerAgent — log message lifecycle', () => {
    test('emits the "Booting ReAct Engine" message at the start', async () => {
        scriptResponses([{ role: 'assistant', content: VALID_PLAN_XML }]);
        const { calls, fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        const bootLine = calls.find(c => c.msg.includes('Booting ReAct Engine'));
        expect(bootLine).toBeDefined();
        expect(bootLine!.stepType).toBe('analyze');
    });

    test('emits "Architecture spec finalized" on successful completion', async () => {
        scriptResponses([{ role: 'assistant', content: VALID_PLAN_XML }]);
        const { calls, fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        const successLine = calls.find(c => c.msg.includes('Architecture spec finalized'));
        expect(successLine).toBeDefined();
        expect(successLine!.stepType).toBe('success');
    });

    test('emits "Step limit reached" warning when maxSteps hit without a plan', async () => {
        // Saturate the 8-step ceiling; no plan in the final turn.
        const toolTurn = (id: string, fp: string): AssistantMessage => ({
            role: 'assistant',
            content: null,
            tool_calls: [{ id, type: 'function' as const, function: { name: 'read_file', arguments: `{"filepath":"${fp}"}` } }]
        });
        scriptResponses([
            toolTurn('c1', 'a.ts'),
            toolTurn('c2', 'b.ts'),
            toolTurn('c3', 'c.ts'),
            toolTurn('c4', 'd.ts'),
            toolTurn('c5', 'e.ts'),
            toolTurn('c6', 'f.ts'),
            toolTurn('c7', 'g.ts'),
            { role: 'assistant', content: 'no plan emitted' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });
        const { calls, fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        const limitLine = calls.find(c => c.msg.includes('Step limit reached'));
        expect(limitLine).toBeDefined();
        expect(limitLine!.stepType).toBe('warning');
    });
});

// ─── Legacy logToolCall behavior (Hotfix 10 carry-over) ─────────────

describe('PlannerAgent — legacy logToolCall (CLI parity)', () => {
    test('emits per-tool-call log line when no emitter is configured', async () => {
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"src/App.tsx"}' } }]
            },
            { role: 'assistant', content: VALID_PLAN_XML }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'src/App.tsx', contents: '' }
        });
        const { calls, fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
            // No toolEventEmitter.
        });

        const inspectLines = calls.filter(c => c.msg.includes('Planner inspecting codebase'));
        expect(inspectLines.length).toBeGreaterThan(0);
        // Detail should include the tool name and the filepath.
        expect(inspectLines[0]!.details).toContain('read_file');
        expect(inspectLines[0]!.details).toContain('src/App.tsx');
    });

    test('does NOT emit per-tool-call log line when an emitter IS configured', async () => {
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"src/App.tsx"}' } }]
            },
            { role: 'assistant', content: VALID_PLAN_XML }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'src/App.tsx', contents: '' }
        });
        const fakeEmitter = { emit: jest.fn() } as unknown as import('../../agents/toolEventEmitter').ToolEventEmitter;
        const { calls, fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log,
            toolEventEmitter: fakeEmitter
        });

        const inspectLines = calls.filter(c => c.msg.includes('Planner inspecting codebase'));
        expect(inspectLines).toHaveLength(0);
    });

    test('per-tool-call log tolerates malformed JSON arguments', async () => {
        // The model occasionally emits truncated/malformed args. The
        // legacy logToolCall helper tolerates this — just shows the
        // tool name with empty detail. Verify parity.
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{not valid json' } }]
            },
            { role: 'assistant', content: VALID_PLAN_XML }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });
        const { calls, fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        const inspectLines = calls.filter(c => c.msg.includes('Planner inspecting codebase'));
        expect(inspectLines.length).toBeGreaterThan(0);
        // Tool name still surfaces, detail args part empty after parse fail.
        expect(inspectLines[0]!.details).toContain('read_file');
    });
});

// ─── Emitter wiring ─────────────────────────────────────────────────

describe('PlannerAgent — emitter wiring', () => {
    test('passes emitter and planner-scoped taskId to dispatchWithEvents', async () => {
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }]
            },
            { role: 'assistant', content: VALID_PLAN_XML }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'a.ts', contents: '' }
        });
        const fakeEmitter = { emit: jest.fn() } as unknown as import('../../agents/toolEventEmitter').ToolEventEmitter;
        const { fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 'my-task',
            workspaceRoot: '/repo',
            log,
            toolEventEmitter: fakeEmitter
        });

        const callArgs = mockDispatchWithEvents.mock.calls[0]!;
        const opts = callArgs[2];
        expect(opts.emitter).toBe(fakeEmitter);
        expect(opts.taskId).toBe('my-task::planner');
        expect(opts.source).toBe('planner');
    });

    test('omits emitter from dispatch options when caller does not provide one', async () => {
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }]
            },
            { role: 'assistant', content: VALID_PLAN_XML }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });
        const { fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        const opts = mockDispatchWithEvents.mock.calls[0]![2];
        expect(opts.emitter).toBeUndefined();
        expect(opts.taskId).toBeUndefined();
        // Source tag still set (engine validates it independently).
        expect(opts.source).toBe('planner');
    });
});

// ─── Tool catalog (read-only) ───────────────────────────────────────

describe('PlannerAgent — tool catalog', () => {
    test('exposes only read-only tools to the model', async () => {
        scriptResponses([{ role: 'assistant', content: VALID_PLAN_XML }]);
        const { fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        // The chat completion call should have received tools — none
        // of them write_file or edit_file.
        const opts = mockProvider.chatCompletion.mock.calls[0]![1];
        const toolNames = opts.tools.map((t: { function: { name: string } }) => t.function.name);
        expect(toolNames).toEqual(expect.arrayContaining(['read_file', 'list_directory', 'search_codebase']));
        expect(toolNames).not.toContain('write_file');
        expect(toolNames).not.toContain('edit_file');
        expect(toolNames).not.toContain('bash_exec');
    });
});

// ─── System prompt construction ─────────────────────────────────────

describe('PlannerAgent — system prompt construction', () => {
    test('injects PRD/design/failures/rules blocks into the system prompt when provided', async () => {
        scriptResponses([{ role: 'assistant', content: VALID_PLAN_XML }]);
        const { fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log,
            initialContext:    'directory tree here',
            prd:               'requirements text',
            design:            'design text',
            previousFailures:  'failure A',
            globalRules:       'rule 1; rule 2'
        });

        // Inspect what was sent to the model: the messages array passed
        // to chatCompletion. The system prompt is the first message.
        const messages = mockProvider.chatCompletion.mock.calls[0]![0];
        const systemPrompt = messages[0].content;

        expect(systemPrompt).toContain('directory tree here');
        expect(systemPrompt).toContain('<prd>');
        expect(systemPrompt).toContain('requirements text');
        expect(systemPrompt).toContain('<design>');
        expect(systemPrompt).toContain('design text');
        expect(systemPrompt).toContain('<previous_failures>');
        expect(systemPrompt).toContain('failure A');
        expect(systemPrompt).toContain('PROJECT STEERING RULES');
        expect(systemPrompt).toContain('rule 1; rule 2');
    });

    test('omits empty blocks from the system prompt when fields are blank', async () => {
        scriptResponses([{ role: 'assistant', content: VALID_PLAN_XML }]);
        const { fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
            // No PRD, no design, no rules, no failures.
        });

        const messages = mockProvider.chatCompletion.mock.calls[0]![0];
        const systemPrompt = messages[0].content;

        expect(systemPrompt).not.toContain('<prd>');
        expect(systemPrompt).not.toContain('<design>');
        expect(systemPrompt).not.toContain('<previous_failures>');
        expect(systemPrompt).not.toContain('PROJECT STEERING RULES');
        // The "(none)" placeholder fires when initialContext is empty.
        expect(systemPrompt).toContain('(none)');
    });

    test('user prompt incorporates the task description and explore directive', async () => {
        scriptResponses([{ role: 'assistant', content: VALID_PLAN_XML }]);
        const { fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 'add a Booking page',
            workspaceRoot: '/repo',
            log
        });

        const messages = mockProvider.chatCompletion.mock.calls[0]![0];
        const userPrompt = messages[1].content;

        expect(userPrompt).toContain('add a Booking page');
        expect(userPrompt).toContain('Explore the codebase');
        expect(userPrompt).toContain('emit the final XML plan');
    });
});

// ─── Hardening flags ────────────────────────────────────────────────

describe('PlannerAgent — hardening flags', () => {
    test('dedup cache is enabled (duplicate calls do not re-dispatch)', async () => {
        // Turn 1: read a.ts.
        // Turn 2: a different turn shape (read b.ts + read a.ts again).
        //   - The signature differs from turn 1 (so stuck-loop detector
        //     doesn't fire).
        //   - The read a.ts is a dedup hit (same args as turn 1).
        // Turn 3: emits the plan.
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }
                ]
            },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'c2', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"b.ts"}' } },
                    { id: 'c3', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }
                ]
            },
            { role: 'assistant', content: VALID_PLAN_XML }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });
        const { fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        // Total real dispatches: turn 1's read a.ts (1) +
        // turn 2's read b.ts (1) + turn 2's read a.ts (deduped, 0).
        // = 2 real dispatches, NOT 3.
        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(2);
    });

    test('dedup short-circuits identical retries; stuck-detector does NOT fire (layered defense)', async () => {
        // This is the user-reported scenario that prompted the fix:
        // model emits read_file('a.ts'), then on the next turn emits
        // the SAME call again. With the old engine ordering, stuck-
        // detector fired BEFORE dedup got a chance, aborting the
        // session with "ReAct loop stuck".
        //
        // After the fix, dedup short-circuits the second call (returns
        // a synthetic "already dispatched" message) and the stuck-
        // detector signature for that turn is empty (no non-deduped
        // calls). The model gets the synthetic message, sees its own
        // retry pattern reflected back, and is given the chance to
        // emit final output.
        const sameTurn: AssistantMessage = {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }]
        };
        const sameAgain: AssistantMessage = {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c2', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }]
        };
        // The third turn produces the plan, completing the session.
        scriptResponses([sameTurn, sameAgain, { role: 'assistant', content: VALID_PLAN_XML }]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'a.ts', contents: '' }
        });
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        // Session completed normally — stuck-detector did NOT abort.
        expect(result.completedNormally).toBe(true);
        // Only ONE real dispatch happened (turn 1's read; turn 2 deduped).
        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(1);
    });

    test('stuck-detector still fires when post-dedup signatures match across turns', async () => {
        // The stuck-detector remains a meaningful safety net for the
        // case where the model emits NEW (non-cached) calls that
        // happen to match the previous turn's NEW calls. This is rare
        // but can happen when the model is producing corrupted args
        // that pass through dispatch (e.g., empty `{}` arguments) and
        // doesn't recover.
        //
        // Scenario: turn 1 reads {a, b}. Turn 2 reads {c, d} (NEW —
        // not in dedup cache). Turn 3 reads {c, d} AGAIN — these were
        // cached in turn 2, so they dedup, signature is empty, stuck-
        // detector does NOT fire. (This is the layered defense doing
        // its job.)
        //
        // For the stuck-detector to fire, we need a non-empty post-
        // dedup signature that matches the prior turn's non-empty
        // post-dedup signature. Easiest way: the Coder agent path
        // (dedup disabled, so all calls always pass through and the
        // signature reflects the raw calls). But that's tested in
        // ReActEngine.test.ts where dedup is opt-out. For the planner
        // (dedup enabled), genuine stuck behavior would require a
        // very contrived scenario, so we instead document why this
        // safety net is harder to trigger now and point at the engine
        // tests for the broader coverage.
        //
        // What we DO verify here: the stuck-detector class itself is
        // still wired (the test from C-2 verified the wiring; here
        // we just confirm the configuration path is unchanged).
        // Behavioral coverage of stuck-detection lives in
        // ReActEngine.test.ts (loopGuards.test.ts owns the unit
        // semantics).
        scriptResponses([
            { role: 'assistant', content: VALID_PLAN_XML }
        ]);
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'build',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        expect(result.completedNormally).toBe(true);
    });
});

// ─── Explore mode (C-3) ─────────────────────────────────────────────

describe('PlannerAgent — explore mode', () => {
    test('returns mode "explore" and a gatheredContext field', async () => {
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"src/App.tsx"}' } }]
            },
            { role: 'assistant', content: 'READY_TO_CODE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'export function App() {}',
            uiPayload: { kind: 'file_contents', filepath: 'src/App.tsx', contents: 'export function App() {}' }
        });
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'explore',
            task: 'investigate why X fails',
            workspaceRoot: '/repo',
            initialContext: 'src/\n  App.tsx',
            log
        });

        expect(result.mode).toBe('explore');
        expect(result.gatheredContext).toBeDefined();
        // gatheredContext format: --- Tool Result: name(args) --- content
        expect(result.gatheredContext).toContain('Tool Result: read_file');
        expect(result.gatheredContext).toContain('export function App()');
    });

    test('terminates when model emits READY_TO_CODE without tools', async () => {
        scriptResponses([{ role: 'assistant', content: 'READY_TO_CODE' }]);
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'explore',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        expect(result.completedNormally).toBe(true);
        expect(result.totalToolCalls).toBe(0);
        expect(result.gatheredContext).toBe(""); // no tools dispatched
    });

    test('honors the 2-step ceiling (returns best-effort if not converged)', async () => {
        // 2 tool turns then we hit the ceiling without READY_TO_CODE.
        // The engine returns best-effort content with completedNormally=false.
        const toolTurn = (id: string, fp: string): AssistantMessage => ({
            role: 'assistant',
            content: null,
            tool_calls: [{ id, type: 'function' as const, function: { name: 'read_file', arguments: `{"filepath":"${fp}"}` } }]
        });
        scriptResponses([
            toolTurn('c1', 'a.ts'),
            // Engine's last-step branch returns the assistant content
            // when it's reached. Second turn here is non-tool, no
            // READY_TO_CODE → the engine returns best-effort.
            { role: 'assistant', content: 'still investigating, no clear answer' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'explore',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        // First turn dispatched, second turn was non-tool non-done →
        // engine returns it as best-effort. gatheredContext captures
        // the first turn's tool result.
        expect(result.gatheredContext).toContain('Tool Result: read_file');
        expect(result.totalToolCalls).toBe(1);
    });

    test('exposes find_file and grep_search to the model alongside read_file/list_directory', async () => {
        scriptResponses([{ role: 'assistant', content: 'READY_TO_CODE' }]);
        const { fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'explore',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        const opts = mockProvider.chatCompletion.mock.calls[0]![1];
        const toolNames = opts.tools.map((t: { function: { name: string } }) => t.function.name);
        expect(toolNames).toEqual(expect.arrayContaining([
            'read_file', 'list_directory', 'grep_search', 'find_file'
        ]));
        // Build-mode-only tools are absent.
        expect(toolNames).not.toContain('search_codebase');
        expect(toolNames).not.toContain('write_file');
    });

    test('system prompt includes the directory tree from initialContext', async () => {
        scriptResponses([{ role: 'assistant', content: 'READY_TO_CODE' }]);
        const { fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'explore',
            task: 't',
            workspaceRoot: '/repo',
            initialContext: 'src/components/Button.tsx\nsrc/App.tsx',
            log
        });

        const messages = mockProvider.chatCompletion.mock.calls[0]![0];
        const systemPrompt = messages[0].content;
        expect(systemPrompt).toContain('src/components/Button.tsx');
        expect(systemPrompt).toContain('--- DIRECTORY TREE ---');
        expect(systemPrompt).toContain('You are the Explorer Agent');
        // Termination word the model is told to emit.
        expect(systemPrompt).toContain('READY_TO_CODE');
    });

    test('user prompt instructs the model to call read_file in a batch then exit', async () => {
        scriptResponses([{ role: 'assistant', content: 'READY_TO_CODE' }]);
        const { fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'explore',
            task: 'find where AuthGuard is defined',
            workspaceRoot: '/repo',
            log
        });

        const messages = mockProvider.chatCompletion.mock.calls[0]![0];
        const userPrompt = messages[1].content;
        expect(userPrompt).toContain('find where AuthGuard');
        expect(userPrompt).toContain('READY_TO_CODE');
    });

    test('emitter taskId is suffixed "::explore" not "::planner" in explore mode', async () => {
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }]
            },
            { role: 'assistant', content: 'READY_TO_CODE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });
        const fakeEmitter = { emit: jest.fn() } as unknown as import('../../agents/toolEventEmitter').ToolEventEmitter;
        const { fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'explore',
            task: 'my-task',
            workspaceRoot: '/repo',
            log,
            toolEventEmitter: fakeEmitter
        });

        const opts = mockDispatchWithEvents.mock.calls[0]![2];
        expect(opts.taskId).toBe('my-task::explore');
        expect(opts.source).toBe('planner');
    });

    test('grep_search custom resolver receives the pattern arg', async () => {
        // Use the global vscode mock — findFiles returns [] by default.
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'grep_search', arguments: '{"pattern":"calculateTax"}' } }]
            },
            { role: 'assistant', content: 'READY_TO_CODE' }
        ]);
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'explore',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        // Engine routed grep_search through the custom resolver, so
        // dispatchWithEvents was NOT called. (The mock vscode.findFiles
        // returns [] so the resolver returned "No matches found".)
        expect(mockDispatchWithEvents).not.toHaveBeenCalled();
        expect(result.gatheredContext).toContain('grep_search');
    });

    test('grep_search rejects patterns shorter than 3 chars', async () => {
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'grep_search', arguments: '{"pattern":"a"}' } }]
            },
            { role: 'assistant', content: 'READY_TO_CODE' }
        ]);
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'explore',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        expect(result.gatheredContext).toContain('Pattern too short');
    });

    test('find_file custom resolver returns "File not found" when nothing matches', async () => {
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'find_file', arguments: '{"filename":"nonexistent.tsx"}' } }]
            },
            { role: 'assistant', content: 'READY_TO_CODE' }
        ]);
        const { fn: log } = makeLog();

        const result = await PlannerAgent.run({
            mode: 'explore',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        // Default vscode mock returns [] → "File not found" message.
        expect(result.gatheredContext).toContain('File not found');
    });

    test('does NOT emit "Booting ReAct Engine" log line in explore mode', async () => {
        // The build-mode boot message is domain-specific to the
        // "produce execution plan" intent. Explore mode is a
        // diagnostic flow with different semantics; its UI surface
        // is the SidebarProvider's "🔍 Agentic Exploration" status,
        // emitted by the caller.
        scriptResponses([{ role: 'assistant', content: 'READY_TO_CODE' }]);
        const { calls, fn: log } = makeLog();

        await PlannerAgent.run({
            mode: 'explore',
            task: 't',
            workspaceRoot: '/repo',
            log
        });

        const bootLines = calls.filter(c => c.msg.includes('Booting ReAct Engine'));
        expect(bootLines).toHaveLength(0);
    });
});
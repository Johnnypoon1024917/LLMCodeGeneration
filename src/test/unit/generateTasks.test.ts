// src/test/unit/generateTasks.test.ts
//
// Tests for the post-2B hotfix: validateTasksPlan + the one-shot
// retry in generateTasks. Two test groups:
//
//   1. validateTasksPlan unit tests — covers all the validation
//      branches independently of the LLM provider
//   2. generateTasks integration tests — mocks the provider to
//      script bad/good responses and verifies the retry/throw
//      behavior
//
// Why both: the validator can be exercised cheaply without mocking;
// the retry path needs the provider mock. Both layers are worth
// testing because they're the two places the bug could regress.

const mockProvider = {
    name: 'mock',
    endpoint: 'http://mock',
    model: 'mock',
    chatCompletion: jest.fn(),
    streamCompletion: jest.fn(),
    streamChatCompletion: jest.fn(),
    completion: jest.fn(),
    jsonCompletion: jest.fn(),
    listModels: jest.fn()
};

jest.mock('../../llm', () => {
    const actual = jest.requireActual('../../llm');
    return {
        ...actual,
        getProvider: async () => mockProvider
    };
});

import { validateTasksPlan, generateTasks } from '../../llmService';
import type { AIPlan, ProjectTask } from '../../llmService';

// ─── validateTasksPlan unit tests ─────────────────────────────────────

describe('validateTasksPlan', () => {
    function task(overrides: Partial<ProjectTask> = {}): ProjectTask {
        return {
            step: 'Add a thing',
            file: 'src/thing.ts',
            detailedInstructions: 'Export a function that returns 42.',
            relatedRequirement: '',
            dependencies: [],
            verificationRules: [],
            testStrategy: '',
            ...overrides
        };
    }

    test('returns null for a clean plan with all fields populated', () => {
        const plan: AIPlan = {
            folderStructure: ['src/'],
            implementationTasks: [task(), task({ step: 'Other', file: 'src/other.ts' })]
        };
        expect(validateTasksPlan(plan)).toBeNull();
    });

    test('flags empty step', () => {
        const plan: AIPlan = {
            folderStructure: [],
            implementationTasks: [task({ step: '' })]
        };
        const result = validateTasksPlan(plan);
        expect(result).toContain('task[0]');
        expect(result).toContain('step');
    });

    test('flags whitespace-only step (matching the screenshot bug)', () => {
        const plan: AIPlan = {
            folderStructure: [],
            implementationTasks: [task({ step: '   ' })]
        };
        const result = validateTasksPlan(plan);
        expect(result).toContain('step');
    });

    test('flags empty file', () => {
        const plan: AIPlan = {
            folderStructure: [],
            implementationTasks: [task({ file: '' })]
        };
        expect(validateTasksPlan(plan)).toContain('file');
    });

    test('flags empty detailedInstructions', () => {
        const plan: AIPlan = {
            folderStructure: [],
            implementationTasks: [task({ detailedInstructions: '' })]
        };
        expect(validateTasksPlan(plan)).toContain('detailedInstructions');
    });

    test('flags multiple missing fields on one task', () => {
        const plan: AIPlan = {
            folderStructure: [],
            implementationTasks: [task({ step: '', file: '', detailedInstructions: '' })]
        };
        const result = validateTasksPlan(plan);
        expect(result).toContain('step');
        expect(result).toContain('file');
        expect(result).toContain('detailedInstructions');
    });

    test('flags only the bad task in a partially-valid plan', () => {
        const plan: AIPlan = {
            folderStructure: [],
            implementationTasks: [
                task(),                       // ok
                task({ step: '' }),          // bad
                task()                        // ok
            ]
        };
        const result = validateTasksPlan(plan);
        expect(result).toContain('task[1]');
        expect(result).not.toContain('task[0]');
        expect(result).not.toContain('task[2]');
    });

    test('caps issue list at 5 entries with "+N more" suffix', () => {
        const badTasks: ProjectTask[] = [];
        for (let i = 0; i < 17; i++) {
            badTasks.push(task({ step: '', file: '', detailedInstructions: '' }));
        }
        const plan: AIPlan = {
            folderStructure: [],
            implementationTasks: badTasks
        };
        const result = validateTasksPlan(plan)!;
        // The first 5 should be listed; the rest summarized.
        expect(result).toContain('task[0]');
        expect(result).toContain('task[4]');
        expect(result).not.toContain('task[5]');
        expect(result).toContain('+12 more');
    });

    test('flags zero-task plan', () => {
        const plan: AIPlan = {
            folderStructure: ['src/'],
            implementationTasks: []
        };
        expect(validateTasksPlan(plan)).toContain('zero tasks');
    });

    test('flags plan with no implementationTasks array', () => {
        // Cast to bypass the type system — this simulates a malformed
        // response from the LLM.
        const plan = { folderStructure: [] } as unknown as AIPlan;
        expect(validateTasksPlan(plan)).toContain('implementationTasks');
    });

    test('accepts plain-string tasks (legacy format)', () => {
        const plan: AIPlan = {
            folderStructure: [],
            implementationTasks: ['Make a thing', 'Make another thing']
        };
        expect(validateTasksPlan(plan)).toBeNull();
    });

    test('flags empty plain-string task', () => {
        const plan: AIPlan = {
            folderStructure: [],
            implementationTasks: ['valid task', '   ']
        };
        const result = validateTasksPlan(plan);
        expect(result).toContain('task[1]');
    });
});

// ─── generateTasks integration tests ──────────────────────────────────

describe('generateTasks — retry behavior', () => {
    beforeEach(() => {
        mockProvider.jsonCompletion.mockReset();
    });

    function goodPlan(): AIPlan {
        return {
            folderStructure: ['src/index.ts'],
            implementationTasks: [
                {
                    step: 'Initialize the entry point',
                    file: 'src/index.ts',
                    detailedInstructions: 'Export a main function that prints hello.',
                    relatedRequirement: '',
                    dependencies: [],
                    verificationRules: [],
                    testStrategy: ''
                }
            ]
        };
    }

    function emptyPlan(): AIPlan {
        return {
            folderStructure: [],
            implementationTasks: [
                {
                    step: '',
                    file: '',
                    detailedInstructions: '',
                    relatedRequirement: '',
                    dependencies: [],
                    verificationRules: [],
                    testStrategy: ''
                },
                {
                    step: '',
                    file: '',
                    detailedInstructions: '',
                    relatedRequirement: '',
                    dependencies: [],
                    verificationRules: [],
                    testStrategy: ''
                }
            ]
        };
    }

    test('passes through when first attempt is valid', async () => {
        mockProvider.jsonCompletion.mockResolvedValueOnce(goodPlan());

        const plan = await generateTasks('PRD content', 'Design content', 'src/');

        expect(mockProvider.jsonCompletion).toHaveBeenCalledTimes(1);
        expect(plan.implementationTasks).toHaveLength(1);
        expect((plan.implementationTasks[0] as ProjectTask).step).toBe('Initialize the entry point');
    });

    test('retries once when first attempt has empty fields and second is clean', async () => {
        mockProvider.jsonCompletion
            .mockResolvedValueOnce(emptyPlan())   // first call: empty
            .mockResolvedValueOnce(goodPlan());   // retry: clean

        const plan = await generateTasks('PRD content', 'Design content', 'src/');

        expect(mockProvider.jsonCompletion).toHaveBeenCalledTimes(2);
        expect(plan.implementationTasks).toHaveLength(1);

        // The retry call should include a corrective system message.
        // Inspect the second call's messages to confirm the corrective
        // prompt was constructed.
        const secondCallMessages = mockProvider.jsonCompletion.mock.calls[1]![0];
        expect(secondCallMessages.length).toBeGreaterThan(2);
        const lastMessage = secondCallMessages[secondCallMessages.length - 1];
        expect(lastMessage.role).toBe('system');
        expect(lastMessage.content).toContain('non-empty');
    });

    test('throws clear error when retry also fails validation', async () => {
        // Both attempts return empty tasks. The function should give up
        // after two tries and throw a user-readable error.
        mockProvider.jsonCompletion
            .mockResolvedValueOnce(emptyPlan())
            .mockResolvedValueOnce(emptyPlan());

        await expect(
            generateTasks('PRD content', 'Design content', 'src/')
        ).rejects.toThrow(/failed validation after retry/);

        expect(mockProvider.jsonCompletion).toHaveBeenCalledTimes(2);
    });

    test('does not retry more than once', async () => {
        // Three empty responses in a row. Function should still only
        // call jsonCompletion twice (initial + one retry) before
        // throwing — never attempt 3.
        mockProvider.jsonCompletion
            .mockResolvedValueOnce(emptyPlan())
            .mockResolvedValueOnce(emptyPlan())
            .mockResolvedValueOnce(goodPlan());  // would succeed if we kept trying

        await expect(
            generateTasks('PRD content', 'Design content', 'src/')
        ).rejects.toThrow();

        expect(mockProvider.jsonCompletion).toHaveBeenCalledTimes(2);
    });

    // ─── Hotfix (post-2B): tailored corrective for zero-tasks failure ───

    function zeroTasksPlan(): AIPlan {
        return {
            folderStructure: [],
            implementationTasks: []
        };
    }

    test('zero-tasks corrective specifically tells the model to produce at least one task', async () => {
        // First attempt: empty array. Retry should be a corrective
        // tailored to zero-tasks (the most common W4A8 failure mode).
        mockProvider.jsonCompletion
            .mockResolvedValueOnce(zeroTasksPlan())
            .mockResolvedValueOnce(goodPlan());

        await generateTasks('PRD content', 'Design content', 'src/');

        const secondCallMessages = mockProvider.jsonCompletion.mock.calls[1]![0];
        const lastMessage = secondCallMessages[secondCallMessages.length - 1];
        expect(lastMessage.role).toBe('system');
        // The corrective should mention "at least one" or "empty array" —
        // NOT just the generic "non-empty values for step/file" message.
        expect(lastMessage.content as string).toMatch(
            /at least one task|empty.*invalid|never return an empty/i
        );
        // It should explicitly call out the user's empty-array mistake
        // (rather than a generic field-level message).
        expect(lastMessage.content as string).toContain('empty implementationTasks array');
    });

    test('field-level corrective does NOT use the zero-tasks language', async () => {
        // First attempt: tasks present but with empty fields. The
        // corrective should be the field-level message, not the
        // zero-tasks message.
        mockProvider.jsonCompletion
            .mockResolvedValueOnce(emptyPlan())
            .mockResolvedValueOnce(goodPlan());

        await generateTasks('PRD content', 'Design content', 'src/');

        const secondCallMessages = mockProvider.jsonCompletion.mock.calls[1]![0];
        const lastMessage = secondCallMessages[secondCallMessages.length - 1];
        expect(lastMessage.role).toBe('system');
        // Field-level corrective uses "non-empty values".
        expect(lastMessage.content as string).toContain('non-empty values');
        // Should NOT contain the zero-tasks specific language.
        expect(lastMessage.content as string).not.toContain('empty implementationTasks array');
    });
});

// ─── P1.2: steering-block injection ────────────────────────────────

describe('generateTasks — steering injection (P1.2)', () => {
    beforeEach(() => {
        mockProvider.jsonCompletion.mockReset();
    });

    function goodPlan() {
        return {
            folderStructure: ['src/'],
            implementationTasks: [
                {
                    step: 'Create src/index.ts',
                    file: 'src/index.ts',
                    detailedInstructions: 'Export a default function.',
                    relatedRequirement: '',
                    dependencies: [],
                    verificationRules: [],
                    testStrategy: ''
                }
            ]
        };
    }

    test('omitting steering produces the legacy 2-message shape', async () => {
        mockProvider.jsonCompletion.mockResolvedValueOnce(goodPlan());
        await generateTasks('PRD', 'Design', '');

        const messages = mockProvider.jsonCompletion.mock.calls[0]![0];
        expect(messages).toHaveLength(2);
        expect(messages[0]!.role).toBe('system');
        expect(messages[1]!.role).toBe('user');
    });

    test('empty-string steering produces the legacy 2-message shape', async () => {
        mockProvider.jsonCompletion.mockResolvedValueOnce(goodPlan());
        await generateTasks('PRD', 'Design', '', undefined, '');

        const messages = mockProvider.jsonCompletion.mock.calls[0]![0];
        expect(messages).toHaveLength(2);
    });

    test('non-empty steering injects a SECOND system message after the planner prompt', async () => {
        mockProvider.jsonCompletion.mockResolvedValueOnce(goodPlan());
        const steering =
            '# Steering: project conventions\n\n' +
            '## tech\n' +
            'Use Result<T,E> instead of throw.\n';
        await generateTasks('PRD', 'Design', '', undefined, steering);

        const messages = mockProvider.jsonCompletion.mock.calls[0]![0];
        expect(messages).toHaveLength(3);
        // Order: planner-system → steering-system → user
        expect(messages[0]!.role).toBe('system');
        expect(messages[0]!.content).toContain('Principal Orchestrator Agent');
        expect(messages[1]!.role).toBe('system');
        expect(messages[1]!.content).toBe(steering);
        expect(messages[2]!.role).toBe('user');
    });

    test('steering survives the corrective-retry path', async () => {
        const steering = '# Steering\n\nNo throws — return Results.';
        // First attempt: empty plan → triggers retry
        // Second attempt: good plan
        mockProvider.jsonCompletion
            .mockResolvedValueOnce({
                folderStructure: [],
                implementationTasks: []
            })
            .mockResolvedValueOnce(goodPlan());

        await generateTasks('PRD', 'Design', '', undefined, steering);

        // The retry call should also include the steering message
        const retryMessages = mockProvider.jsonCompletion.mock.calls[1]![0];
        // First call had 3 messages; retry adds 1 corrective, so 4
        expect(retryMessages).toHaveLength(4);
        // Steering should still be the second system message
        expect(retryMessages[1]!.role).toBe('system');
        expect(retryMessages[1]!.content).toBe(steering);
        // Corrective should be the LAST message
        expect(retryMessages[3]!.role).toBe('system');
        // Empty implementationTasks triggers the zero-tasks corrective,
        // which uses different language than the field-level corrective
        expect(retryMessages[3]!.content).toContain('empty implementationTasks array');
    });

    test('steering content goes through unchanged (not re-wrapped)', async () => {
        mockProvider.jsonCompletion.mockResolvedValueOnce(goodPlan());
        const steering = 'arbitrary content with NO header at all';
        await generateTasks('PRD', 'Design', '', undefined, steering);

        const messages = mockProvider.jsonCompletion.mock.calls[0]![0];
        // Steering string passed to generateTasks is what reaches the LLM,
        // verbatim. The "wrapping with header" responsibility lives in
        // formatSteeringPromptBlock — generateTasks is a pure pass-through
        // for whatever string the caller gave it.
        expect(messages[1]!.content).toBe(steering);
    });
});
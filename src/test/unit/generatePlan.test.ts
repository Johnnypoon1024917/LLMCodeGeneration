// src/test/unit/generatePlan.test.ts
//
// Tests for the post-2B audit fix to generatePlan:
//
//   - generatePlan now uses the ProjectTask shape (`step`, `file`,
//     `detailedInstructions`) instead of the legacy `description`,
//     `targetFile`, `instructions` shape. The webview's renderer reads
//     ProjectTask fields, so the legacy shape produced blank task
//     titles for every Vibe-mode plan.
//   - validateTasksPlan + one-shot retry pattern is now applied here
//     too (parallel to generateTasks). Empty fields trigger a
//     corrective retry; persistent failure throws a clear error.
//
// We mock the `./llm/jsonRequest` module because generatePlan uses
// `jsonRequestData` directly (not provider.jsonCompletion). The
// mockJsonRequestData fn lets each test script the LLM responses.

const mockJsonRequestData = jest.fn();

jest.mock('../../llm/jsonRequest', () => ({
    jsonRequestData: (...args: unknown[]) => mockJsonRequestData(...args),
    // Also stub the named exports that other code paths might import.
    jsonRequest: jest.fn(),
    resetJsonRequestCache: jest.fn()
}));

import { generatePlan } from '../../llmService';
import type { AIPlan, ProjectTask } from '../../llmService';

describe('generatePlan — post-2B audit fix', () => {
    beforeEach(() => {
        mockJsonRequestData.mockReset();
    });

    function goodPlan(): AIPlan {
        return {
            folderStructure: ['src/index.ts', 'src/components/Nav.tsx'],
            implementationTasks: [
                {
                    step: 'Add booking tab to navigation',
                    file: 'src/components/Nav.tsx',
                    detailedInstructions: 'Insert a new <Tab> after the existing tabs, route to /booking.',
                    relatedRequirement: 'Booking flow',
                    dependencies: [],
                    verificationRules: [],
                    testStrategy: ''
                } as ProjectTask
            ]
        };
    }

    function emptyTasksPlan(): AIPlan {
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
                } as ProjectTask,
                {
                    step: '',
                    file: '',
                    detailedInstructions: '',
                    relatedRequirement: '',
                    dependencies: [],
                    verificationRules: [],
                    testStrategy: ''
                } as ProjectTask
            ]
        };
    }

    test('returns clean plan with ProjectTask field shape', async () => {
        mockJsonRequestData.mockResolvedValueOnce({
            explanation: 'Add booking flow',
            plan: goodPlan()
        });

        const result = await generatePlan('Add booking flow', 'existing structure');

        expect(mockJsonRequestData).toHaveBeenCalledTimes(1);
        expect(result.explanation).toBe('Add booking flow');
        expect(result.plan.implementationTasks).toHaveLength(1);

        const task = result.plan.implementationTasks[0] as ProjectTask;
        expect(task.step).toBe('Add booking tab to navigation');
        expect(task.file).toBe('src/components/Nav.tsx');
        expect(task.detailedInstructions).toBeTruthy();
    });

    test('schema sent to jsonRequestData wraps the ProjectTask shape (not legacy)', async () => {
        mockJsonRequestData.mockResolvedValueOnce({
            explanation: 'whatever',
            plan: goodPlan()
        });

        await generatePlan('prompt', 'context');

        const callArgs = mockJsonRequestData.mock.calls[0]![0];
        const schemaProps = callArgs.schema.schema.properties.plan.properties;

        // The new shape: tasksPlanSchema has folderStructure + implementationTasks
        expect(schemaProps).toHaveProperty('folderStructure');
        expect(schemaProps).toHaveProperty('implementationTasks');

        // The implementationTasks items should have the ProjectTask required fields
        const taskRequired = schemaProps.implementationTasks.items.required;
        expect(taskRequired).toContain('step');
        expect(taskRequired).toContain('file');
        expect(taskRequired).toContain('detailedInstructions');
        // The legacy fields (description/targetFile/instructions) should NOT be required
        expect(taskRequired).not.toContain('description');
        expect(taskRequired).not.toContain('targetFile');
    });

    test('retries once when first attempt has empty fields and second is clean', async () => {
        mockJsonRequestData
            .mockResolvedValueOnce({ explanation: 'first', plan: emptyTasksPlan() })  // bad
            .mockResolvedValueOnce({ explanation: 'second', plan: goodPlan() });       // good

        const result = await generatePlan('prompt', 'context');

        expect(mockJsonRequestData).toHaveBeenCalledTimes(2);
        expect((result.plan.implementationTasks[0] as ProjectTask).step).toBeTruthy();

        // Second call should include a corrective system message
        const secondCallMessages = mockJsonRequestData.mock.calls[1]![0].messages;
        expect(secondCallMessages.length).toBeGreaterThan(2);
        const lastMessage = secondCallMessages[secondCallMessages.length - 1];
        expect(lastMessage.role).toBe('system');
        expect(lastMessage.content).toContain('non-empty');
    });

    test('throws clear error when retry also fails validation', async () => {
        mockJsonRequestData
            .mockResolvedValueOnce({ explanation: 'first', plan: emptyTasksPlan() })
            .mockResolvedValueOnce({ explanation: 'second', plan: emptyTasksPlan() });

        await expect(
            generatePlan('prompt', 'context')
        ).rejects.toThrow(/failed validation after retry/);

        expect(mockJsonRequestData).toHaveBeenCalledTimes(2);
    });

    test('does not retry more than once (verifies no infinite loop)', async () => {
        mockJsonRequestData
            .mockResolvedValueOnce({ explanation: '1', plan: emptyTasksPlan() })
            .mockResolvedValueOnce({ explanation: '2', plan: emptyTasksPlan() })
            .mockResolvedValueOnce({ explanation: '3', plan: goodPlan() });

        await expect(
            generatePlan('prompt', 'context')
        ).rejects.toThrow();

        expect(mockJsonRequestData).toHaveBeenCalledTimes(2);
    });

    test('handles missing folderStructure gracefully (defaults to empty)', async () => {
        // Plan returned without folderStructure but with valid tasks.
        // Schema requires folderStructure, but if validation upstream
        // is loose, our defensive default shouldn't crash.
        mockJsonRequestData.mockResolvedValueOnce({
            explanation: 'no folder structure',
            plan: { implementationTasks: goodPlan().implementationTasks } as AIPlan
        });

        const result = await generatePlan('prompt', 'context');
        // Tasks are valid, so no retry. folderStructure may be undefined
        // but the function should still return without crashing.
        expect(result.plan.implementationTasks).toHaveLength(1);
    });
});
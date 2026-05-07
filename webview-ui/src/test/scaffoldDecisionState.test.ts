// webview-ui/src/scaffoldDecisionState.test.ts
//
// Tests for the V2.1.2b scaffold decision state machine. Pure module
// — no React, no DOM. Verifies:
//
//   - Happy path: idle → requesting → deciding → acknowledging → idle
//     with shouldSubmitOriginal at the end
//   - Skip-dialog paths: not greenfield, or no templates
//   - User cancellation drops the payload
//   - Apply error transitions to 'failed' and surfaces the error
//   - Stale messages (decisionAvailable when not requesting) ignored
//   - Double submit ignored

import { describe, it, expect } from 'vitest';
import {
    initialScaffoldDecisionState,
    reduceScaffoldDecision,
    type DecisionAvailable,
    type CapturedPayload,
} from '../scaffoldDecisionState';

const samplePayload: CapturedPayload = {
    type: 'processUserMessage',
    text: 'build me a TypeScript CLI',
};

const greenfieldDecision: DecisionAvailable = {
    isGreenfield: true,
    confidence: 'high',
    stackHint: 'node-ts-cli',
    templates: [
        { id: 'node-ts-cli', displayName: 'Node TS CLI', description: '', stackTags: [], source: 'builtin' },
        { id: 'python-cli', displayName: 'Python CLI', description: '', stackTags: [], source: 'builtin' },
    ],
};

const notGreenfieldDecision: DecisionAvailable = {
    isGreenfield: false,
    confidence: 'low',
    templates: [
        { id: 'node-ts-cli', displayName: 'Node TS CLI', description: '', stackTags: [], source: 'builtin' },
    ],
};

const greenfieldNoTemplates: DecisionAvailable = {
    isGreenfield: true,
    confidence: 'high',
    templates: [],
};

describe('scaffoldDecisionState — happy path', () => {
    it('runs idle → requesting → deciding → acknowledging → idle on apply success', () => {
        // 1. User submits
        let step = reduceScaffoldDecision(initialScaffoldDecisionState, {
            type: 'userSubmitted',
            payload: samplePayload,
        });
        expect(step.state.phase).toBe('requesting');
        expect(step.state.capturedPayload).toEqual(samplePayload);
        expect(step.shouldRequestScaffoldCheck).toBe(true);
        expect(step.shouldSubmitOriginal).toBe(false);

        // 2. Host returns greenfield decision
        step = reduceScaffoldDecision(step.state, {
            type: 'decisionAvailable',
            decision: greenfieldDecision,
        });
        expect(step.state.phase).toBe('deciding');
        expect(step.state.decision).toEqual(greenfieldDecision);
        expect(step.shouldSubmitOriginal).toBe(false);

        // 3. User picks a template
        step = reduceScaffoldDecision(step.state, {
            type: 'userPicked',
            action: 'apply',
            templateId: 'node-ts-cli',
        });
        expect(step.state.phase).toBe('acknowledging');
        expect(step.shouldSubmitOriginal).toBe(false);

        // 4. Host acknowledges (no error)
        step = reduceScaffoldDecision(step.state, {
            type: 'decisionAcknowledged',
            applyError: null,
        });
        expect(step.state).toEqual(initialScaffoldDecisionState);
        expect(step.shouldSubmitOriginal).toBe(true);
    });
});

describe('scaffoldDecisionState — skip-dialog paths', () => {
    it('submits immediately when not greenfield', () => {
        const afterSubmit = reduceScaffoldDecision(initialScaffoldDecisionState, {
            type: 'userSubmitted',
            payload: samplePayload,
        });
        const afterDecision = reduceScaffoldDecision(afterSubmit.state, {
            type: 'decisionAvailable',
            decision: notGreenfieldDecision,
        });
        expect(afterDecision.state).toEqual(initialScaffoldDecisionState);
        expect(afterDecision.shouldSubmitOriginal).toBe(true);
    });

    it('submits immediately when greenfield but no templates', () => {
        const afterSubmit = reduceScaffoldDecision(initialScaffoldDecisionState, {
            type: 'userSubmitted',
            payload: samplePayload,
        });
        const afterDecision = reduceScaffoldDecision(afterSubmit.state, {
            type: 'decisionAvailable',
            decision: greenfieldNoTemplates,
        });
        expect(afterDecision.shouldSubmitOriginal).toBe(true);
    });

    it('user picks skip — proceeds through ack and submits original', () => {
        let step = reduceScaffoldDecision(initialScaffoldDecisionState, {
            type: 'userSubmitted',
            payload: samplePayload,
        });
        step = reduceScaffoldDecision(step.state, {
            type: 'decisionAvailable',
            decision: greenfieldDecision,
        });
        step = reduceScaffoldDecision(step.state, {
            type: 'userPicked',
            action: 'skip',
            templateId: null,
        });
        expect(step.state.phase).toBe('acknowledging');
        step = reduceScaffoldDecision(step.state, {
            type: 'decisionAcknowledged',
            applyError: null,
        });
        expect(step.shouldSubmitOriginal).toBe(true);
    });
});

describe('scaffoldDecisionState — cancel path', () => {
    it('user cancels — drops the payload, does NOT submit', () => {
        let step = reduceScaffoldDecision(initialScaffoldDecisionState, {
            type: 'userSubmitted',
            payload: samplePayload,
        });
        step = reduceScaffoldDecision(step.state, {
            type: 'decisionAvailable',
            decision: greenfieldDecision,
        });
        step = reduceScaffoldDecision(step.state, {
            type: 'userPicked',
            action: 'cancel',
            templateId: null,
        });
        expect(step.state).toEqual(initialScaffoldDecisionState);
        expect(step.shouldSubmitOriginal).toBe(false);
    });
});

describe('scaffoldDecisionState — error path', () => {
    it('apply failure transitions to failed state with error visible', () => {
        let step = reduceScaffoldDecision(initialScaffoldDecisionState, {
            type: 'userSubmitted',
            payload: samplePayload,
        });
        step = reduceScaffoldDecision(step.state, {
            type: 'decisionAvailable',
            decision: greenfieldDecision,
        });
        step = reduceScaffoldDecision(step.state, {
            type: 'userPicked',
            action: 'apply',
            templateId: 'node-ts-cli',
        });
        step = reduceScaffoldDecision(step.state, {
            type: 'decisionAcknowledged',
            applyError: 'Scaffold refused: 3 file(s) would be overwritten: package.json, README.md, src/index.ts',
        });
        expect(step.state.phase).toBe('failed');
        expect(step.state.lastError).toContain('would be overwritten');
        expect(step.state.capturedPayload).toEqual(samplePayload); // payload preserved
        expect(step.state.decision).toEqual(greenfieldDecision);    // decision preserved
        expect(step.shouldSubmitOriginal).toBe(false);
    });

    it('user can retry from failed state by picking again', () => {
        // Drive into failed state
        let step = reduceScaffoldDecision(initialScaffoldDecisionState, {
            type: 'userSubmitted',
            payload: samplePayload,
        });
        step = reduceScaffoldDecision(step.state, {
            type: 'decisionAvailable',
            decision: greenfieldDecision,
        });
        step = reduceScaffoldDecision(step.state, {
            type: 'userPicked',
            action: 'apply',
            templateId: 'node-ts-cli',
        });
        step = reduceScaffoldDecision(step.state, {
            type: 'decisionAcknowledged',
            applyError: 'something went wrong',
        });
        expect(step.state.phase).toBe('failed');

        // User picks skip from the failed dialog
        step = reduceScaffoldDecision(step.state, {
            type: 'userPicked',
            action: 'skip',
            templateId: null,
        });
        expect(step.state.phase).toBe('acknowledging');
    });
});

describe('scaffoldDecisionState — guards', () => {
    it('ignores double submit while flow in progress', () => {
        const first = reduceScaffoldDecision(initialScaffoldDecisionState, {
            type: 'userSubmitted',
            payload: samplePayload,
        });
        const otherPayload: CapturedPayload = { type: 'other', text: 'different prompt' };
        const second = reduceScaffoldDecision(first.state, {
            type: 'userSubmitted',
            payload: otherPayload,
        });
        expect(second.state).toEqual(first.state);
        expect(second.shouldRequestScaffoldCheck).toBe(false);
    });

    it('ignores stale decisionAvailable when not requesting', () => {
        const stale = reduceScaffoldDecision(initialScaffoldDecisionState, {
            type: 'decisionAvailable',
            decision: greenfieldDecision,
        });
        expect(stale.state).toEqual(initialScaffoldDecisionState);
        expect(stale.shouldSubmitOriginal).toBe(false);
    });

    it('ignores stale acknowledgment when not acknowledging', () => {
        const stale = reduceScaffoldDecision(initialScaffoldDecisionState, {
            type: 'decisionAcknowledged',
            applyError: null,
        });
        expect(stale.state).toEqual(initialScaffoldDecisionState);
        expect(stale.shouldSubmitOriginal).toBe(false);
    });

    it('reset clears state from any phase', () => {
        let step = reduceScaffoldDecision(initialScaffoldDecisionState, {
            type: 'userSubmitted',
            payload: samplePayload,
        });
        step = reduceScaffoldDecision(step.state, {
            type: 'decisionAvailable',
            decision: greenfieldDecision,
        });
        // Now in deciding phase
        step = reduceScaffoldDecision(step.state, { type: 'reset' });
        expect(step.state).toEqual(initialScaffoldDecisionState);
    });
});
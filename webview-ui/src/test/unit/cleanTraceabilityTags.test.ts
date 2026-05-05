// src/test/unit/cleanTraceabilityTags.test.ts
//
// Tests for `cleanTraceabilityTags`, the pure helper that converts the
// Coordinator's traceability tags (model/api/response/field/param/etc.)
// into displayable markdown. Pure function, exported from App.tsx for
// testability. Sees substantial use during plan rendering when the
// model emits structured PRD content with traceability annotations —
// regressions here would garble the rendered plan output.

import { describe, test, expect } from 'vitest';
import { cleanTraceabilityTags } from '../../App';

describe('cleanTraceabilityTags — empty/edge inputs', () => {
    test('empty string returns empty string', () => {
        expect(cleanTraceabilityTags('')).toBe('');
    });

    test('plain text passes through unchanged', () => {
        expect(cleanTraceabilityTags('hello world')).toBe('hello world');
    });

    test('whitespace-only input is trimmed', () => {
        expect(cleanTraceabilityTags('   \n\n   ')).toBe('');
    });
});

describe('cleanTraceabilityTags — model/api tags become markdown headers', () => {
    test('<model id="X"> wraps to ### Model: `X`', () => {
        const input = '<model id="UserAccount">User has email and id</model>';
        const out = cleanTraceabilityTags(input);
        expect(out).toContain('### 🗄️ Model: `UserAccount`');
    });

    test('<api method="GET" route="/users"> becomes ### `GET` `/users`', () => {
        const input = '<api method="GET" route="/users">Lists users</api>';
        const out = cleanTraceabilityTags(input);
        expect(out).toContain('### 🔌 `GET` `/users`');
    });

    test('case-insensitive tag matching', () => {
        // The regexes use /gi — uppercase tag names should still match.
        const input = '<MODEL id="X">test</MODEL>';
        const out = cleanTraceabilityTags(input);
        expect(out).toContain('### 🗄️ Model: `X`');
    });
});

describe('cleanTraceabilityTags — fields and params', () => {
    test('<field name="email" type="string" required="true">', () => {
        const input = '<field name="email" type="string" required="true" description="User email"/>';
        const out = cleanTraceabilityTags(input);
        expect(out).toContain('`email`');
        expect(out).toContain('(string)');
        expect(out).toContain('`Required`');
        expect(out).toContain('User email');
    });

    test('field without required attribute has no required badge', () => {
        const input = '<field name="bio" type="string" description="Optional bio"/>';
        const out = cleanTraceabilityTags(input);
        expect(out).toContain('`bio`');
        expect(out).not.toContain('`Required`');
        expect(out).not.toContain('`Optional`');
    });

    test('field with required=false shows Optional badge', () => {
        const input = '<field name="age" type="number" required="false" description="Age"/>';
        const out = cleanTraceabilityTags(input);
        expect(out).toContain('`Optional`');
    });

    test('field with no name falls back to "unknown"', () => {
        // Defensive: malformed input shouldn't crash.
        const input = '<field type="string" description="something"/>';
        const out = cleanTraceabilityTags(input);
        expect(out).toContain('`unknown`');
    });
});

describe('cleanTraceabilityTags — response tags consolidate to bullet lines', () => {
    test('response with code and description becomes status bullet', () => {
        const input = '<response><code>200</code><description>OK response</description></response>';
        const out = cleanTraceabilityTags(input);
        expect(out).toContain('📤 Status `200`: OK response');
    });
});

describe('cleanTraceabilityTags — strips structural tags entirely', () => {
    test('epic/story/criteria/metadata tags are removed', () => {
        const input = '<epic id="1">title</epic><story>desc</story><criteria>x</criteria>';
        const out = cleanTraceabilityTags(input);
        expect(out).not.toContain('<epic');
        expect(out).not.toContain('</epic>');
        expect(out).not.toContain('<story>');
        expect(out).not.toContain('</story>');
        // The text content between tags is preserved.
        expect(out).toContain('title');
        expect(out).toContain('desc');
    });
});

describe('cleanTraceabilityTags — request/query tags become subheaders', () => {
    test('<request> becomes #### Request Body', () => {
        const input = '<request>field stuff</request>';
        const out = cleanTraceabilityTags(input);
        // Valid markdown requires a space between the # marks and the
        // heading text. The implementation correctly emits `#### Request
        // Body` (with space). The previous assertion `####Request Body`
        // (no space) would have produced an invalid heading that no
        // markdown renderer treats as a heading. Test corrected during
        // Sprint 2 PR 2.3.
        expect(out).toContain('#### Request Body');
    });

    test('<query> becomes #### Query Parameters', () => {
        const input = '<query>params here</query>';
        const out = cleanTraceabilityTags(input);
        // Same reason as above: valid markdown requires a space.
        expect(out).toContain('#### Query Parameters');
    });
});

describe('cleanTraceabilityTags — newline normalization', () => {
    test('three or more consecutive newlines collapse to two', () => {
        const input = 'line1\n\n\n\n\nline2';
        const out = cleanTraceabilityTags(input);
        // Should contain at most two consecutive newlines anywhere in
        // the output. The trim() at the end handles leading/trailing.
        expect(out).not.toMatch(/\n{3,}/);
        expect(out).toContain('line1');
        expect(out).toContain('line2');
    });
});
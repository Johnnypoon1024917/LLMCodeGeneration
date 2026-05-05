// src/test/unit/taskDependencies.test.ts
//
// PR P1.2 (deferred-infra): tests for cross-task dependency awareness.
//
// What this covers:
//   - Parser extraction: <task dependsOn="..."> populates ParsedTask.dependencies
//   - topologicalOrder: produces a dependency-respecting order, stable
//     for ties, with input order preserved when no deps are declared
//   - Issue detection: unknown ids, self-references, cycles
//
// What this does NOT cover:
//   - LLM prompt tuning to make the planner emit dependencies. That
//     waits for real fixture data — see roadmap deferral note.

import {
    TaskTracker,
    topologicalOrder,
    findDependencyIssues,
    type ParsedTask,
} from '../../specs/TaskTracker';

describe('TaskTracker.parse — dependsOn extraction', () => {
    it('defaults dependencies to empty array when attribute is absent', () => {
        const md = `
<task id="TASK-001" targetFile="src/a.ts">
1. [ ] **Do thing** (File: \`src/a.ts\`)
</task>
        `.trim();
        const tasks = TaskTracker.parse(md);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]!.dependencies).toEqual([]);
    });

    it('treats dependsOn="none" as empty', () => {
        const md = `
<task id="TASK-001" dependsOn="none">
1. [ ] **Do thing**
</task>
        `.trim();
        expect(TaskTracker.parse(md)[0]!.dependencies).toEqual([]);
    });

    it('parses a single dependency', () => {
        const md = `
<task id="TASK-002" dependsOn="TASK-001">
1. [ ] **Do thing**
</task>
        `.trim();
        expect(TaskTracker.parse(md)[0]!.dependencies).toEqual(['TASK-001']);
    });

    it('parses comma-separated dependencies', () => {
        const md = `
<task id="TASK-003" dependsOn="TASK-001,TASK-002">
1. [ ] **Do thing**
</task>
        `.trim();
        expect(TaskTracker.parse(md)[0]!.dependencies).toEqual(['TASK-001', 'TASK-002']);
    });

    it('trims whitespace around comma-separated ids', () => {
        const md = `
<task id="TASK-003" dependsOn="TASK-001 , TASK-002 , TASK-004">
1. [ ] **Do thing**
</task>
        `.trim();
        expect(TaskTracker.parse(md)[0]!.dependencies).toEqual(['TASK-001', 'TASK-002', 'TASK-004']);
    });

    it('handles empty string after split (trailing comma)', () => {
        const md = `
<task id="TASK-002" dependsOn="TASK-001,">
1. [ ] **Do thing**
</task>
        `.trim();
        expect(TaskTracker.parse(md)[0]!.dependencies).toEqual(['TASK-001']);
    });

    it('treats case-insensitive "None" as empty', () => {
        const md = `
<task id="TASK-001" dependsOn="None">
1. [ ] **Do thing**
</task>
        `.trim();
        expect(TaskTracker.parse(md)[0]!.dependencies).toEqual([]);
    });
});

describe('topologicalOrder — basic ordering', () => {
    function mkTask(id: string, deps: string[] = []): ParsedTask {
        return { id, description: id, status: 'pending', dependencies: deps };
    }

    it('preserves input order when there are no dependencies', () => {
        const tasks = [mkTask('A'), mkTask('B'), mkTask('C')];
        const result = topologicalOrder(tasks);
        expect(result.ordered.map((t) => t.id)).toEqual(['A', 'B', 'C']);
        expect(result.issues).toEqual([]);
    });

    it('orders a simple chain', () => {
        // Input is in REVERSE order — should be sorted to A, B, C
        const tasks = [
            mkTask('C', ['B']),
            mkTask('B', ['A']),
            mkTask('A'),
        ];
        const result = topologicalOrder(tasks);
        expect(result.ordered.map((t) => t.id)).toEqual(['A', 'B', 'C']);
        expect(result.issues).toEqual([]);
    });

    it('handles diamond dependency', () => {
        //   A
        //  / \
        // B   C
        //  \ /
        //   D
        const tasks = [
            mkTask('D', ['B', 'C']),
            mkTask('B', ['A']),
            mkTask('C', ['A']),
            mkTask('A'),
        ];
        const result = topologicalOrder(tasks);
        const order = result.ordered.map((t) => t.id);
        expect(order[0]).toBe('A');
        expect(order[3]).toBe('D');
        expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
        expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
        expect(result.issues).toEqual([]);
    });

    it('handles tasks without ids (cant be referenced)', () => {
        const tasks: ParsedTask[] = [
            { description: 'no-id', status: 'pending', dependencies: [] },
            mkTask('B', []),
        ];
        const result = topologicalOrder(tasks);
        expect(result.ordered).toHaveLength(2);
        expect(result.issues).toEqual([]);
    });

    it('produces stable order on ties (input order)', () => {
        // Two roots, no deps between them. Input order should be preserved.
        const tasks = [mkTask('Z'), mkTask('A')];
        const result = topologicalOrder(tasks);
        expect(result.ordered.map((t) => t.id)).toEqual(['Z', 'A']);
    });
});

describe('topologicalOrder — issue detection', () => {
    function mkTask(id: string, deps: string[] = []): ParsedTask {
        return { id, description: id, status: 'pending', dependencies: deps };
    }

    it('reports unknown dependency ids', () => {
        const tasks = [mkTask('A', ['MISSING'])];
        const result = topologicalOrder(tasks);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]!.kind).toBe('unknown_id');
        expect(result.issues[0]!.taskId).toBe('A');
        expect(result.issues[0]!.detail).toBe('MISSING');
        // Task is still emitted so the UI can render it
        expect(result.ordered.map((t) => t.id)).toEqual(['A']);
    });

    it('reports self-references', () => {
        const tasks = [mkTask('A', ['A'])];
        const result = topologicalOrder(tasks);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]!.kind).toBe('self_reference');
        expect(result.issues[0]!.taskId).toBe('A');
        expect(result.issues[0]!.detail).toBe('A');
        // After dropping the self-ref, A has no deps and orders cleanly
        expect(result.ordered.map((t) => t.id)).toEqual(['A']);
    });

    it('detects two-node cycles', () => {
        const tasks = [
            mkTask('A', ['B']),
            mkTask('B', ['A']),
        ];
        const result = topologicalOrder(tasks);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]!.kind).toBe('cycle');
        const detail = result.issues[0]!.detail as string[];
        expect(detail).toContain('A');
        expect(detail).toContain('B');
        // Both tasks still emitted (in some order) so UI can render
        expect(result.ordered).toHaveLength(2);
    });

    it('detects three-node cycles', () => {
        const tasks = [
            mkTask('A', ['B']),
            mkTask('B', ['C']),
            mkTask('C', ['A']),
        ];
        const result = topologicalOrder(tasks);
        const cycles = result.issues.filter((i) => i.kind === 'cycle');
        expect(cycles).toHaveLength(1);
        const detail = cycles[0]!.detail as string[];
        expect(detail.length).toBeGreaterThanOrEqual(3);
    });

    it('detects multiple disjoint cycles separately', () => {
        const tasks = [
            mkTask('A', ['B']),
            mkTask('B', ['A']),
            mkTask('X', ['Y']),
            mkTask('Y', ['X']),
        ];
        const result = topologicalOrder(tasks);
        const cycles = result.issues.filter((i) => i.kind === 'cycle');
        expect(cycles).toHaveLength(2);
    });

    it('reports cycle alongside acyclic tasks correctly', () => {
        const tasks = [
            mkTask('ROOT'),
            mkTask('A', ['B']),
            mkTask('B', ['A']),
            mkTask('LEAF', ['ROOT']),
        ];
        const result = topologicalOrder(tasks);
        const cycles = result.issues.filter((i) => i.kind === 'cycle');
        expect(cycles).toHaveLength(1);
        // ROOT and LEAF are not in the cycle and should order normally
        const order = result.ordered.map((t) => t.id);
        expect(order.indexOf('ROOT')).toBeLessThan(order.indexOf('LEAF'));
    });

    it('mixes unknown_id and cycle on same plan', () => {
        const tasks = [
            mkTask('A', ['B', 'GHOST']),
            mkTask('B', ['A']),
        ];
        const result = topologicalOrder(tasks);
        expect(result.issues.some((i) => i.kind === 'unknown_id' && i.detail === 'GHOST')).toBe(true);
        expect(result.issues.some((i) => i.kind === 'cycle')).toBe(true);
    });
});

describe('findDependencyIssues — pure validator', () => {
    it('returns same issues as topologicalOrder', () => {
        const tasks: ParsedTask[] = [
            { id: 'A', description: 'A', status: 'pending', dependencies: ['MISSING'] },
        ];
        const fromIssues = findDependencyIssues(tasks);
        const fromTopo = topologicalOrder(tasks).issues;
        expect(fromIssues).toEqual(fromTopo);
    });

    it('returns empty array on a clean DAG', () => {
        const tasks: ParsedTask[] = [
            { id: 'A', description: 'A', status: 'pending', dependencies: [] },
            { id: 'B', description: 'B', status: 'pending', dependencies: ['A'] },
        ];
        expect(findDependencyIssues(tasks)).toEqual([]);
    });
});
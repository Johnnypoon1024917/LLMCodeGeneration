// src/test/unit/startupTiming.test.ts
//
// PR P3.2: tests for the startup timing module.

import {
    mark,
    getMarks,
    getMarksRelative,
    durationBetween,
    resetForTests,
} from '../../diagnostics/startupTiming';

beforeEach(() => {
    resetForTests();
});

describe('mark + getMarks', () => {
    it('returns an empty array initially', () => {
        expect(getMarks()).toEqual([]);
    });

    it('records marks in order', () => {
        mark('first');
        mark('second');
        mark('third');
        const m = getMarks();
        expect(m).toHaveLength(3);
        expect(m.map((x) => x.name)).toEqual(['first', 'second', 'third']);
    });

    it('returns a copy — mutations dont affect storage', () => {
        mark('one');
        const m = getMarks();
        m.push({ name: 'rogue', timestamp: 0 });
        expect(getMarks()).toHaveLength(1);
    });

    it('records monotonically increasing timestamps', () => {
        mark('a');
        // tiny delay
        for (let i = 0; i < 100000; i++) { /* burn */ }
        mark('b');
        const m = getMarks();
        expect(m[1]!.timestamp).toBeGreaterThanOrEqual(m[0]!.timestamp);
    });

    it('allows the same name to be recorded multiple times', () => {
        mark('phase');
        mark('phase');
        expect(getMarks()).toHaveLength(2);
    });
});

describe('getMarksRelative', () => {
    it('returns empty for empty buffer', () => {
        expect(getMarksRelative()).toEqual([]);
    });

    it('first mark has sinceStartMs = 0', () => {
        mark('first');
        const rel = getMarksRelative();
        expect(rel[0]!.sinceStartMs).toBe(0);
    });

    it('later marks have positive deltas', () => {
        mark('start');
        // Burn some cycles to ensure a measurable gap
        for (let i = 0; i < 1000000; i++) { /* burn */ }
        mark('later');
        const rel = getMarksRelative();
        expect(rel[1]!.sinceStartMs).toBeGreaterThanOrEqual(0);
    });
});

describe('durationBetween', () => {
    it('returns null when "from" mark is missing', () => {
        mark('only');
        expect(durationBetween('missing', 'only')).toBeNull();
    });

    it('returns null when "to" mark is missing', () => {
        mark('only');
        expect(durationBetween('only', 'missing')).toBeNull();
    });

    it('returns the duration between two recorded marks', () => {
        mark('start');
        for (let i = 0; i < 1000000; i++) { /* burn */ }
        mark('end');
        const d = durationBetween('start', 'end');
        expect(d).not.toBeNull();
        expect(d!).toBeGreaterThanOrEqual(0);
    });

    it('uses the LAST occurrence of "to" when it repeats', () => {
        mark('start');
        mark('phase');
        mark('phase');  // last 'phase' is what gets used
        const d = durationBetween('start', 'phase')!;
        const marks2 = getMarks();
        const expectedDuration = marks2[2]!.timestamp - marks2[0]!.timestamp;
        expect(d).toBe(expectedDuration);
    });

    it('uses the FIRST occurrence of "from" when it repeats', () => {
        mark('start');
        mark('start');
        mark('end');
        const d = durationBetween('start', 'end')!;
        const marks2 = getMarks();
        // Duration from FIRST 'start' to last 'end'
        const expectedDuration = marks2[2]!.timestamp - marks2[0]!.timestamp;
        expect(d).toBe(expectedDuration);
    });
});
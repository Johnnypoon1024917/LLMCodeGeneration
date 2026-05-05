// src/test/unit/__mocks__/commandDenylist.ts
//
// Jest mock for src/agents/commandDenylist (which doesn't exist yet —
// it's a leftover from PR 0 audit work that never got written). Without
// this mock, any unit test that transitively imports from CoderAgent
// (via Coordinator → CoderAgent → securityHook → commandDenylist)
// fails to compile under ts-jest.
//
// The mock evaluates everything as 'allow' because unit tests don't
// exercise the bash dispatch path. The test that DOES exercise it
// (securityHook unit tests, when written) should mock evaluateCommand
// per-test, not rely on this default.
//
// When a real commandDenylist.ts lands in src/agents/, this mock can
// be deleted — Jest's moduleNameMapper does NOT re-route requests when
// the real module exists at the import path.

export type DenylistVerdict =
    | { kind: 'allow' }
    | { kind: 'deny'; reason: string; pattern: string };

export function evaluateCommand(_cmd: string): DenylistVerdict {
    return { kind: 'allow' };
}
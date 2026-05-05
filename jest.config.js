// jest.config.js
//
// Jest configuration for unit tests.
//
// Why we have BOTH jest and vscode-test:
//   - vscode-test (existing) runs integration tests inside a real VS Code
//     instance. Required for anything that calls the vscode API, like the
//     SidebarProvider.
//   - jest (this config) runs unit tests for pure-logic modules — string
//     parsers, validators, helpers — without the overhead of booting VS
//     Code. Tests run in Node, not the Extension Host.
//
// Test discovery:
//   `**/*.test.ts` under `src/test/unit/` — separate from `src/test/extension.test.ts`
//   (the existing vscode-test entry point) so the two runners never confuse each other.

/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: 'src',
    testMatch: ['<rootDir>/test/unit/**/*.test.ts'],
    // Map the `vscode` module to a hand-rolled mock. Real vscode only exists
    // inside the Extension Host; unit tests run in plain Node and would crash
    // on `import 'vscode'`. The mock provides just enough surface for
    // module-loading to succeed (window, workspace, Uri, ConfigurationTarget).
    // Tests that need richer vscode behavior should use the integration test
    // runner (vscode-test), not this mock.
    moduleNameMapper: {
        '^vscode$': '<rootDir>/test/unit/__mocks__/vscode.ts',
        // P1.1: tests that transitively import Coordinator pull in
        // CoderAgent → securityHook → commandDenylist. The real
        // commandDenylist.ts hasn't been written yet (PR 0 audit
        // leftover). This mock returns 'allow' for every command so
        // imports resolve. When the real module exists, this entry
        // is a no-op.
        '\\./commandDenylist$': '<rootDir>/test/unit/__mocks__/commandDenylist.ts'
    },
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            // Use a relaxed tsconfig for tests — we don't need the strict-extra
            // flags here, just type-check the test bodies. Tests invoking the
            // production code still benefit from production's strict types via
            // import resolution.
            tsconfig: {
                strict: true,
                target: 'ES2022',
                module: 'commonjs',
                esModuleInterop: true,
                allowSyntheticDefaultImports: true,
                types: ['jest', 'node'],
                // P1.1: isolatedModules tells ts-jest to type-check only the
                // file being compiled, not the transitive dep graph. Needed
                // because Coordinator transitively imports through
                // securityHook → commandDenylist (which doesn't exist yet —
                // PR 0 audit leftover). Without this, ANY test importing
                // from Coordinator fails to compile.
                //
                // Tradeoff: tests get slightly weaker type checking
                // (cross-file inference can miss things). Production
                // typecheck via `npm run compile` still catches them.
                isolatedModules: true
            }
        }]
    },
    // Suppress the "no projects found" message when there are zero tests
    // (e.g. CI run before tests are written).
    passWithNoTests: true
};
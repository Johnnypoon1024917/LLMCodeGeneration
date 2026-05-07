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
                // Type-check the file being compiled, not the transitive
                // dep graph. Speeds up tests and produces simpler errors
                // when something goes wrong. Production typecheck via
                // `npm run compile` still catches cross-file issues.
                //
                // V2.1.2 spec-fix-8 history: this flag was originally
                // added to work around the missing commandDenylist.ts —
                // that file now exists, but the flag remains for the
                // speed/simplicity benefit it provides.
                isolatedModules: true
            }
        }]
    },
    // Suppress the "no projects found" message when there are zero tests
    // (e.g. CI run before tests are written).
    passWithNoTests: true
};
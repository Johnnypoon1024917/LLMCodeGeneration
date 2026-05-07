import { defineConfig } from '@vscode/test-cli';

// Two labels:
//
//   default  — fast extension tests. Run on every PR.
//
//   fixtures — slow end-to-end agent baseline runs. Self-skips unless an
//              LLM endpoint is configured. Run nightly or on-demand:
//              `npm run compile && npx vscode-test --label fixtures`
//
// They're separated because the fixture suite can take 30+ minutes per
// run depending on the agent and endpoint, and we don't want it on the
// PR critical path until v1's success rate stabilizes.
//
// Endpoint configuration:
//   The test VS Code instance has its OWN settings store (under
//   .vscode-test/user-data/) which doesn't inherit from your daily
//   VS Code's settings.json. To avoid duplicating the setting, the
//   fixtures label honors NEXUSCODE_API_ENDPOINT / NEXUSCODE_API_KEY
//   env vars passed through to the test process. Set them in your
//   shell before running:
//
//     set NEXUSCODE_API_ENDPOINT=http://127.0.0.1:8001/v1/chat/completions
//     set NEXUSCODE_API_KEY=<your-key-or-empty-string>
//     npm run fixtures
//
// fixtures.test.ts checks both VS Code settings AND env vars, so
// either source works.
export default defineConfig([
    {
        label: 'default',
        files: 'out/test/extension.test.js'
    },
    {
        label: 'fixtures',
        files: 'out/test/fixtures.test.js',
        // Forward the endpoint env vars from the parent shell into the
        // test VS Code instance. Without this, child Electron processes
        // get a sanitized env that drops most NEXUSCODE_* vars.
        launchArgs: [
            // Disable workspace trust for the test instance — fixtures
            // run in fresh tempdirs and would otherwise hit a "trust
            // this folder?" dialog that blocks the suite indefinitely.
            '--disable-workspace-trust',
            // P1.0 (2026-05): defeat the "Code is currently being
            // updated" startup race on Windows. Without this, on a
            // freshly-downloaded test VS Code instance the update
            // checker fires before the test runner gets control,
            // producing an unhelpful exit code 1.
            //
            // Cause: vscode-test downloads VS Code into
            // .vscode-test/vscode-<platform>-<version>/ once and
            // reuses it. On first launch, that instance does an
            // update check. The check races with the test driver
            // and on Windows the loser is the test driver.
            //
            // Fix: --disable-updates is a documented Code CLI flag
            // that skips update checks entirely. Test instances
            // don't need to update; they use whatever version
            // vscode-test pinned.
            '--disable-updates'
        ]
    }
]);

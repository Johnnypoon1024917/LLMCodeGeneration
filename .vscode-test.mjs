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
export default defineConfig([
    {
        label: 'default',
        files: 'out/test/extension.test.js'
    },
    {
        label: 'fixtures',
        files: 'out/test/fixtures.test.js'
    }
]);

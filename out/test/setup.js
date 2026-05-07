"use strict";
// src/test/setup.ts
//
// Test setup. Runs before each test file. Two responsibilities:
//
// 1. Install the `acquireVsCodeApi` mock on `window`. Components in this
//    webview call this synchronously at module top-level (e.g.,
//    `const vscode = (window as any).acquireVsCodeApi();` in App.tsx).
//    Without the mock, importing App.tsx in a test crashes the test
//    file before any `describe()` runs. Install BEFORE imports.
//
// 2. Extend Vitest's `expect` with @testing-library/jest-dom matchers
//    (toBeInTheDocument, toHaveClass, etc.) so tests can assert on DOM
//    state idiomatically.
//
// Per-test mock state is reset by `vi.clearAllMocks()` in an
// afterEach hook so tests don't leak postMessage spies into each other.
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVsCodeApiMock = getVsCodeApiMock;
const vitest_1 = require("vitest");
require("@testing-library/jest-dom/vitest");
const react_1 = require("@testing-library/react");
// VS Code webview API stub. The real API has three methods:
//   - postMessage(msg): send a message to the extension host
//   - getState(): read persisted state
//   - setState(state): persist state across webview reloads
//
// All three are stubbed as vi.fn() so tests can spy on them and assert
// what the webview tried to send back to the extension.
const vscodeApiMock = {
    postMessage: vitest_1.vi.fn(),
    getState: vitest_1.vi.fn(),
    setState: vitest_1.vi.fn(),
};
// Cast to any to avoid having to declare the global TypeScript type —
// `acquireVsCodeApi` is an injected runtime function, not a real DOM API.
globalThis.acquireVsCodeApi = () => vscodeApiMock;
// Expose the mock for tests that want to assert against postMessage
// calls. Tests can `import { getVsCodeApiMock } from '../setup'` to
// retrieve it. Storing on globalThis avoids issues with module
// caching in vitest's worker pool.
globalThis.__vscodeApiMock = vscodeApiMock;
function getVsCodeApiMock() {
    return globalThis.__vscodeApiMock;
}
// matchMedia is referenced by some lucide-react / CSS-in-JS code paths
// even when no media query is actually queried. jsdom doesn't implement
// it. Stub returns "no match" — components that branch on dark/light
// preference will get the light branch, which is fine for unit tests.
if (!window.matchMedia) {
    window.matchMedia = (query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vitest_1.vi.fn(), // legacy API
        removeListener: vitest_1.vi.fn(),
        addEventListener: vitest_1.vi.fn(),
        removeEventListener: vitest_1.vi.fn(),
        dispatchEvent: vitest_1.vi.fn(),
    });
}
// Pre-initialize the i18n bootstrap by importing the module. The webview
// production code imports `./i18n` from main.tsx, which runs the bootstrap
// at startup. Tests don't go through main.tsx, so we import it here to
// trigger the same initialization. Without this, components calling
// `useTranslation()` during render will warn "useTranslation: You will
// need to pass in an i18next instance" and fall back to returning the
// translation key as the rendered text. Tests pass either way (the
// fallback is harmless), but the warning pollutes test output and would
// hide real i18n bugs if we ever assert on translated content.
//
// Side-effect import — the i18n module's top-level code initializes the
// instance synchronously (the `init()` call returns a promise but the
// instance is registered with React-i18next immediately).
require("../i18n");
// Reset all mocks between tests. This includes the postMessage spy on
// the vscode API mock — without this reset, assertions like
// `expect(postMessage).toHaveBeenCalledWith(...)` would see calls from
// previous tests.
//
// Unmount any React components rendered in the previous test. Vitest
// + jsdom don't reset the DOM between tests in the same file by
// default. Testing-library's auto-cleanup hook runs only when
// `afterEach` is a global, but our vitest config sets `globals: false`
// so we register cleanup explicitly here. Without this, "found
// multiple elements" errors surface in tests that share render targets.
(0, vitest_1.afterEach)(() => {
    (0, react_1.cleanup)();
    vitest_1.vi.clearAllMocks();
});
//# sourceMappingURL=setup.js.map
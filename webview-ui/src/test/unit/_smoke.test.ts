// src/test/unit/_smoke.test.ts
//
// Smoke test for the webview test infrastructure. Verifies that:
//   - Vitest runs at all
//   - The setup file loaded (vscode API mock is on globalThis)
//   - jsdom is providing window/document
//
// If this test fails, the test infrastructure itself is broken — fix
// it before debugging individual feature tests.

import { describe, test, expect } from 'vitest';
import { getVsCodeApiMock } from '../setup';

describe('webview test infrastructure smoke', () => {
    test('vitest is running', () => {
        expect(true).toBe(true);
    });

    test('jsdom provides window and document', () => {
        expect(typeof window).toBe('object');
        expect(typeof document).toBe('object');
        expect(document.body).toBeDefined();
    });

    test('vscode API mock is installed on globalThis', () => {
        const api = (globalThis as any).acquireVsCodeApi();
        expect(api).toBeDefined();
        expect(typeof api.postMessage).toBe('function');
        expect(typeof api.getState).toBe('function');
        expect(typeof api.setState).toBe('function');
    });

    test('mock is retrievable via getVsCodeApiMock helper', () => {
        const mock = getVsCodeApiMock();
        expect(mock).toBeDefined();
        // The mock returned by the helper is the same instance the
        // production code receives via acquireVsCodeApi().
        const api = (globalThis as any).acquireVsCodeApi();
        expect(api).toBe(mock);
    });

    test('postMessage calls are spy-able and reset between tests', () => {
        const mock = getVsCodeApiMock();
        // Should be empty at start of every test (afterEach clears).
        expect(mock.postMessage).not.toHaveBeenCalled();
        mock.postMessage({ type: 'test' });
        expect(mock.postMessage).toHaveBeenCalledTimes(1);
    });
});
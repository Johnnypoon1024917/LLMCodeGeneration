/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Test config for the webview UI. Inherits Vite's React plugin and the
// `@i18n-locales` alias so test imports resolve identically to the
// production build. Uses jsdom for DOM emulation (needed by
// @testing-library/react). Test setup file at `src/test/setup.ts` runs
// before each test file — it installs the `acquireVsCodeApi` mock that
// App.tsx and other components require.
//
// Why a separate config file rather than inlining `test:` into
// vite.config.ts: vitest's config is forward-compat with Vite's, but
// inlining would mean production builds have to parse vitest types
// (and would force vitest to be a runtime dep of the build, not just a
// devDep). Separation keeps the production build pristine.

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@i18n-locales': path.resolve(__dirname, '../src/i18n/locales')
        }
    },
    test: {
        environment: 'jsdom',
        globals: false, // explicit imports (vi, describe, etc.) — no globals
        setupFiles: ['./src/test/setup.ts'],
        include: ['src/test/**/*.test.{ts,tsx}'],
        // Match the backend test directory shape so the mental model is
        // consistent: tests live under src/test/unit/* and src/test/
        // integration/* (when we add integration tests later).
        css: false, // skip CSS parsing — tests don't depend on visual output
    },
});
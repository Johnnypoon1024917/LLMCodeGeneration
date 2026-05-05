import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Note: this Vite config has a few opinions worth knowing about before
// editing.
//
// 1. `assetFileNames: 'static/[ext]/[name].[ext]'`
//    This is what produces `build/static/css/style.css` (NOT index.css).
//    The extension's SidebarProvider expects `style.css` and has been
//    bitten by drift to `index.css` four times in the past. Do not change
//    this without coordinating with SidebarProvider's CSS reference.
//
// 2. `format: 'iife', inlineDynamicImports: true`
//    Produces a single self-contained JS bundle (no dynamic chunk loading).
//    Required because the webview runs inside VS Code's webview iframe with
//    a strict CSP that blocks dynamically-loaded chunks.
//
//    NB: This is also why the audit's M-3 fix (lazy-load the Map view via
//    React.lazy) was a no-op at runtime — Rollup flattens the dynamic
//    import boundary into the main bundle anyway. Real bundle savings
//    have to come from removing dependencies (e.g., replacing the 3D
//    force graph with a lighter-weight 2D SVG; deferred to Sprint 4).
//
// 3. `resolve.alias['@i18n-locales']`
//    Points to the extension-side i18n locale directory so the webview can
//    import the SAME en.json the extension uses. Single source of truth —
//    eliminates the duplication problem from i18n Session A. To add a new
//    locale, drop a JSON file in `src/i18n/locales/` and import it through
//    this alias from both runtimes.
//
// 4. `tailwindcss()` plugin (Sprint 1 PR 1.1)
//    Tailwind v4's first-party Vite plugin. Auto-detects template files
//    (so we don't maintain a content array), reads `@theme` from the
//    main CSS to expose CSS-variable tokens as utility classes, and
//    integrates with Lightning CSS for prod minification. Order matters
//    — must come after react() so JSX class names are scanned correctly.

export default defineConfig({
    plugins: [react(), tailwindcss()],
    base: './',
    resolve: {
        alias: {
            '@i18n-locales': path.resolve(__dirname, '../src/i18n/locales')
        }
    },
    build: {
        outDir: 'build',
        emptyOutDir: true,
        cssCodeSplit: false,
        rollupOptions: {
            output: {
                format: 'iife',
                inlineDynamicImports: true,
                entryFileNames: 'static/js/main.js',
                chunkFileNames: 'static/js/[name].js',
                assetFileNames: 'static/[ext]/[name].[ext]'
            }
        }
    }
});
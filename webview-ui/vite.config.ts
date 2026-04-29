import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
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
// 3. `resolve.alias['@i18n-locales']`
//    Points to the extension-side i18n locale directory so the webview can
//    import the SAME en.json the extension uses. Single source of truth —
//    eliminates the duplication problem from i18n Session A. To add a new
//    locale, drop a JSON file in `src/i18n/locales/` and import it through
//    this alias from both runtimes.

export default defineConfig({
    plugins: [react()],
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
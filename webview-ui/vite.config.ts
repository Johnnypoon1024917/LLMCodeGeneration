import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    base: './',
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
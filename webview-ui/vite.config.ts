import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // Relative paths for VS Code webview
  build: {
    outDir: '../out/webview', // Output to extension's out/ for packaging
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'webview.js', // Single bundle file
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
  server: {
    port: 3000, // Dev server for HMR
    hmr: { overlay: false }, // Disable overlay in webview
  },
});
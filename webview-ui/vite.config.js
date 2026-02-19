import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react({ jsxRuntime: 'classic' })],
  base: './',
  esbuild: {
    loader: 'tsx',  // Handle JSX/TSX syntax explicitly
    include: /src\/.*\.[tj]sx?$/  // Apply to all .js/.jsx/.ts/.tsx in src/
  },
  build: {
    outDir: '../out/webview',
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'webview.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
  server: {
    port: 3000,
    hmr: { overlay: false },
  },
});
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'build',
    // Empty the build directory before every new build
    emptyOutDir: true,
    // Turn off chunking to keep everything in a single file
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // Force predictable file names
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`,
      },
    },
  },
});
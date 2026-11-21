import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Builds the Chrome extension (side panel + background worker + content script) into
// web/dist-extension. Load that folder via chrome://extensions, then "Load unpacked".
export default defineConfig({
  root: resolve(import.meta.dirname, 'extension'),
  envDir: import.meta.dirname,
  publicDir: resolve(import.meta.dirname, 'extension/public'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist-extension'),
    emptyOutDir: true,
    // Extensions can't load remote code; keep everything local and readable for review.
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'extension/sidepanel.html'),
        background: resolve(import.meta.dirname, 'extension/src/background.ts'),
        content: resolve(import.meta.dirname, 'extension/src/content.ts'),
      },
      output: {
        // The manifest points at fixed names for the worker and content script.
        entryFileNames: (chunk) =>
          chunk.name === 'background' || chunk.name === 'content' ? '[name].js' : 'assets/[name]-[hash].js',
      },
    },
  },
})

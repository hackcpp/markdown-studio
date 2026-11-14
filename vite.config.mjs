import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@codemirror/') || id.includes('/node_modules/@lezer/') ||
              id.includes('/node_modules/codemirror/')) return 'editor'
        }
      }
    }
  }
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'index.html'),
        background: resolve(__dirname, 'src/background.ts'),
        content: resolve(__dirname, 'src/content.ts')
      },
      output: {
        // For background and content, output fixed names
        entryFileNames: chunk => {
          if (chunk.name === 'background' || chunk.name === 'content') {
            return '[name].js'
          }
          // For other chunks (like your popup code), use the default hash format
          return 'assets/[name]-[hash].js'
        }
      }
    }
  }
})
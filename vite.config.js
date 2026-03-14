import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const popupEntry = fileURLToPath(new URL('./index.html', import.meta.url))
const backgroundEntry = fileURLToPath(new URL('./src/background.ts', import.meta.url))
const contentEntry = fileURLToPath(new URL('./src/content.ts', import.meta.url))

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        popup: popupEntry,
        background: backgroundEntry,
        content: contentEntry
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

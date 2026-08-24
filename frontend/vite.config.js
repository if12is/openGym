import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const backend = process.env.API_TARGET || 'http://127.0.0.1:3000'
const media = process.env.MEDIA_TARGET || 'http://127.0.0.1:8888'
const verFile = join(process.cwd(), 'android', 'app-version.json')
const ver = existsSync(verFile) ? JSON.parse(readFileSync(verFile, 'utf8')) : {}

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(ver.versionName || ''),
    'import.meta.env.VITE_APP_VERSION_CODE': JSON.stringify(String(ver.versionCode || '')),
  },
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/img': { target: media, changeOrigin: true },
      '/gif': { target: media, changeOrigin: true }
    }
  },
  build: { chunkSizeWarningLimit: 1500 }
})

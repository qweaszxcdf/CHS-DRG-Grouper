import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const isLite = env.VITE_LITE === 'true'
  const suffix = isLite ? '-lite' : ''
  return {
    // Use relative paths so built assets work when opened via file://
    base: './',
    // Keep hooks and the renderer on the same React module instance in dev,
    // including when Vite's dependency optimizer/HMR reloads this app.
    resolve: {
      dedupe: ['react', 'react-dom'],
    },
    build: {
      outDir: `dist${suffix}`,
      emptyOutDir: true,
    },
    plugins: [react()],
  }
})

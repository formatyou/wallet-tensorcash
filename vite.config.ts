import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  // Operator environment files and VITE_* variables are never frontend inputs.
  envDir: false,
  envPrefix: [],
  css: { postcss: {} },
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8790', '/health': 'http://127.0.0.1:8790' } },
  build: { target: 'es2022', sourcemap: false },
  worker: { format: 'es' },
});

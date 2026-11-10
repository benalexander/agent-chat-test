import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the worker from admin/dist as static assets → app lives at /admin/index.html.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: { outDir: 'dist/admin', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/admin/api': 'http://localhost:8787' },
  },
});

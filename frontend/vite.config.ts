import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': decodeURIComponent(new URL('./src', import.meta.url).pathname) },
  },
  base: '/',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: { portal: 'portal.html', admin: 'admin/index.html' },
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:4173', ws: true },
      '/papi': { target: 'http://127.0.0.1:4180', ws: true },
    },
  },
});

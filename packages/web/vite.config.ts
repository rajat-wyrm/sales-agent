import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@/components': path.resolve(import.meta.dirname, './src/components'),
      '@/hooks': path.resolve(import.meta.dirname, './src/hooks'),
      '@/lib': path.resolve(import.meta.dirname, './src/lib'),
      '@/stores': path.resolve(import.meta.dirname, './src/stores'),
      '@/pages': path.resolve(import.meta.dirname, './src/pages'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
      '/sse': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/sse/, '/api/sse'),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Route-level React.lazy in App.tsx already defers recharts + the table lib
    // into their route chunks (loaded only when that route opens). Forcing them
    // into GLOBAL manualChunks would re-hoist them into the entry's preload list,
    // so we ONLY split truly-shared framework code here.
    rollupOptions: {
      output: {
        // Rolldown (Vite 8) requires the function form of manualChunks.
        manualChunks(id) {
          if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|@remix-run)[\\/]/.test(id)) {
            return 'vendor';
          }
          if (/node_modules[\\/]zustand[\\/]/.test(id)) {
            return 'state';
          }
        },
      },
    },
  },
});

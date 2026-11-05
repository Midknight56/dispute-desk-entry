import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../public/dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { index: 'web/index.html', studio: 'web/studio.html', proof: 'web/proof.html' },
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor';
          if (/node_modules\/ag-grid-[^/]+\//.test(id)) return 'ag-grid';
          if (/node_modules\/ag-charts-[^/]+\//.test(id)) return 'ag-charts';
        },
      },
    },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8787', '/health': 'http://127.0.0.1:8787' } },
});

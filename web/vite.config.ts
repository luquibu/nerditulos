import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

// The dev server proxies the API and the audio socket to a server run on the host. The target
// port comes from PORT in the repository root's .env.local, the same file the server reads.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  const port = loadEnv(mode, repoRoot, 'PORT').PORT || '3000';
  return {
    plugins: [react()],
    worker: { format: 'es' },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      target: 'es2022',
    },
    server: {
      proxy: {
        '/api': `http://127.0.0.1:${port}`,
        '/ws': { target: `ws://127.0.0.1:${port}`, ws: true },
      },
    },
  };
});

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Pagina Studio (split view): vanilla TS, nessun framework.
export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  base: '/',
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});

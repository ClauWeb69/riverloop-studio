import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Overlay iniettato nell'app dal proxy: un solo file IIFE, senza dipendenze esterne.
export default defineConfig({
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: fileURLToPath(new URL('./dist/overlay', import.meta.url)),
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    minify: 'esbuild',
    lib: {
      entry: fileURLToPath(new URL('./src/overlay/index.ts', import.meta.url)),
      formats: ['iife'],
      name: 'RiverloopStudioOverlay',
      fileName: () => 'overlay.js',
    },
  },
});

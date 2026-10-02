import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Anche i file CommonJS dei plugin (.cts) passano dal compilatore TypeScript
  esbuild: { include: /\.(?:[cm]?ts|[jt]sx)$/ },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    // I test controllano i testi in italiano (la lingua di riferimento)
    env: { RIVERLOOP_STUDIO_LANG: 'it' },
  },
});

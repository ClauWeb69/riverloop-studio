// Next.js: file e riga esatti di ogni elemento JSX, con webpack e con Turbopack.
//
//   // next.config.ts / next.config.mjs
//   import { withStudio } from 'riverloop-studio/next';
//   export default withStudio({ /* la tua configurazione */ });
//
//   // next.config.js
//   const { withStudio } = require('riverloop-studio/next');
//   module.exports = withStudio({ /* la tua configurazione */ });
//
// In produzione (next build) la configurazione resta quella di partenza.
import path from 'node:path';

type NextConfig = Record<string, unknown>;
type ConfigFn = (phase: string, ctx: unknown) => NextConfig | Promise<NextConfig>;
type WebpackFn = (config: WebpackConfig, ctx: { dev?: boolean }) => WebpackConfig;
interface WebpackConfig {
  module?: { rules?: unknown[] };
  [key: string]: unknown;
}

const LOADER = path.join(__dirname, 'loader.cjs');
const GLOBS = ['*.tsx', '*.jsx'];

/** Versione di Next.js installata nel progetto (null se non si trova). */
function nextVersion(cwd: string): [number, number] | null {
  try {
    const file = require.resolve('next/package.json', { paths: [cwd] });

    const version = String((require(file) as { version?: string }).version ?? '');
    const m = /^(\d+)\.(\d+)/.exec(version);
    return m ? [Number(m[1]), Number(m[2])] : null;
  } catch {
    return null;
  }
}

function apply(config: NextConfig, cwd: string): NextConfig {
  const rule = { loaders: [{ loader: LOADER, options: { root: cwd } }] };
  const rules = Object.fromEntries(GLOBS.map((g) => [g, rule]));
  const out: NextConfig = { ...config };

  // Turbopack: "turbopack" da Next.js 15.3, prima "experimental.turbo"
  const version = nextVersion(cwd);
  const topLevel = !version || version[0] > 15 || (version[0] === 15 && version[1] >= 3);
  if (topLevel) {
    const current = (config.turbopack ?? {}) as { rules?: Record<string, unknown> };
    out.turbopack = { ...current, rules: { ...rules, ...(current.rules ?? {}) } };
  } else {
    const experimental = (config.experimental ?? {}) as { turbo?: { rules?: Record<string, unknown> } };
    const turbo = experimental.turbo ?? {};
    out.experimental = { ...experimental, turbo: { ...turbo, rules: { ...rules, ...(turbo.rules ?? {}) } } };
  }

  // webpack
  const previous = config.webpack as WebpackFn | undefined;
  const webpack: WebpackFn = (webpackConfig, ctx) => {
    if (ctx?.dev) {
      webpackConfig.module ??= {};
      webpackConfig.module.rules ??= [];
      webpackConfig.module.rules.push({
        test: /\.[jt]sx$/,
        exclude: /node_modules/,
        enforce: 'pre',
        use: [{ loader: LOADER, options: { root: cwd } }],
      });
    }
    return typeof previous === 'function' ? previous(webpackConfig, ctx) : webpackConfig;
  };
  out.webpack = webpack;
  return out;
}

/** Avvolge la configurazione di Next.js (oggetto o funzione). */
export function withStudio<T extends NextConfig | ConfigFn>(config?: T): T {
  const cwd = process.cwd();
  const production = () => process.env.NODE_ENV === 'production';
  if (typeof config === 'function') {
    const fn = config as ConfigFn;
    const wrapped: ConfigFn = async (phase, ctx) => {
      const resolved = await fn(phase, ctx);
      return production() || phase === 'phase-production-build' ? resolved : apply(resolved, cwd);
    };
    return wrapped as T;
  }
  const base = (config ?? {}) as NextConfig;
  return (production() ? base : apply(base, cwd)) as T;
}

export default withStudio;

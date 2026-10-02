// Plugin per Vite: file e riga esatti di ogni elemento JSX (attributo data-studio-src).
//
//   // vite.config.ts
//   import studio from 'riverloop-studio/vite';
//   export default defineConfig({ plugins: [studio(), react()] });
//
// Va messo prima del plugin di React. Agisce solo con il dev server (apply: 'serve').
import type { Plugin } from 'vite';
import { sourceTaggingDisabled, tagSource } from './transform.cjs';

export interface StudioViteOptions {
  /** File da marcare (default: .jsx e .tsx fuori da node_modules). */
  include?: RegExp;
  /** Nome dell'attributo (default data-studio-src). */
  attribute?: string;
  /** Agisce anche sotto i test del progetto (Vitest), dove di norma resta spento. */
  always?: boolean;
}

export default function riverloopStudio(options: StudioViteOptions = {}): Plugin {
  const include = options.include ?? /\.[jt]sx$/i;
  let root = process.cwd();
  return {
    name: 'riverloop-studio:source',
    enforce: 'pre',
    apply: 'serve',
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      const file = id.split('?')[0];
      // Con Vitest il dev server serve anche i test: lì gli attributi sporcherebbero gli snapshot
      if ((sourceTaggingDisabled() && !options.always) || !include.test(file) || /[\\/]node_modules[\\/]/.test(file)) return null;
      const result = tagSource(code, file, { root, attribute: options.attribute });
      return result ? { code: result.code, map: result.map } : null;
    },
  };
}

export { riverloopStudio };

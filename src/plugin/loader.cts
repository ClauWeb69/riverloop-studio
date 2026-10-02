// Loader per webpack e Turbopack (Next.js): file e riga esatti di ogni elemento JSX.
// Gira prima del compilatore del progetto (SWC/Babel) e lavora sul sorgente originale, quindi
// righe e colonne sono quelle del file. Di solito si usa tramite withStudio() di
// riverloop-studio/next. Nelle build di produzione lascia passare il sorgente invariato.
import { sourceTaggingDisabled, tagSource } from './transform.cjs';

interface LoaderContext {
  resourcePath: string;
  rootContext?: string;
  cacheable?: (flag?: boolean) => void;
  getOptions?: () => { root?: string; attribute?: string; always?: boolean } | undefined;
  callback: (err: Error | null, content?: string, map?: unknown) => void;
}

function riverloopStudioLoader(this: LoaderContext, source: string, inputMap?: unknown): void {
  this.cacheable?.(true);
  let options: { root?: string; attribute?: string; always?: boolean } = {};
  try {
    options = this.getOptions?.() ?? {};
  } catch {
    /* opzioni non disponibili: valori predefiniti */
  }
  const file = this.resourcePath;
  if ((sourceTaggingDisabled() && !options.always) || /[\\/]node_modules[\\/]/.test(file)) {
    this.callback(null, source, inputMap);
    return;
  }
  const result = tagSource(source, file, { root: options.root || this.rootContext || process.cwd(), attribute: options.attribute });
  if (!result) {
    this.callback(null, source, inputMap);
    return;
  }
  // Se un loader precedente ha già prodotto una mappa la lasciamo: le righe non cambiano.
  this.callback(null, result.code, inputMap ?? JSON.parse(result.map.toString()));
}

export = riverloopStudioLoader;

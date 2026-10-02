// Fase 3: aggiunge a ogni elemento JSX "host" (div, button, h1...) l'attributo
// data-studio-src="percorso/relativo.tsx:riga:colonna", così l'overlay di Studio dice a Claude
// il file e la riga esatti dell'elemento annotato. Vale solo in sviluppo: i plugin che usano
// questa funzione (Vite, Babel, loader per Next.js) non la applicano alle build di produzione.
//
// File CommonJS (.cts): i loader di webpack/Turbopack e i plugin di Babel si caricano con require.
import path from 'node:path';
import { parse, type ParserPlugin } from '@babel/parser';
import MagicString from 'magic-string';

export const SOURCE_ATTRIBUTE = 'data-studio-src';

export interface TagSourceOptions {
  /** Radice del progetto: i percorsi nell'attributo sono relativi a questa cartella. */
  root?: string;
  /** Nome dell'attributo (default data-studio-src). */
  attribute?: string;
}

export interface TagSourceResult {
  code: string;
  map: ReturnType<MagicString['generateMap']>;
  /** Elementi marcati. */
  count: number;
}

interface AstNode {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
}

const SKIP_KEYS = new Set(['loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'tokens', 'errors']);

/** Percorso da scrivere nell'attributo: relativo alla radice, con le barre "/". */
export function sourcePath(filename: string, root?: string): string {
  const file = filename.split('?')[0];
  const posix = (p: string) => p.replace(/\\/g, '/');
  if (root && path.isAbsolute(file)) {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return posix(rel);
  }
  return posix(file);
}

// Elementi HTML e SVG. Un nome minuscolo non basta: altri renderer di React usano tag minuscoli
// per oggetti che non sono elementi del DOM (React Three Fiber: <mesh>, <boxGeometry>...), e lì
// un attributo con i trattini verrebbe letto come un percorso di proprietà, rompendo l'app.
const HTML_TAGS =
  'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp search section select slot small source span strong sub summary sup table tbody td template textarea tfoot th thead time tr track u ul var video wbr';
const SVG_TAGS =
  'svg circle clipPath defs desc ellipse feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDropShadow feFlood feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset feSpecularLighting feTile feTurbulence filter foreignObject g image line linearGradient marker mask metadata path pattern polygon polyline radialGradient rect stop switch symbol text textPath tspan use view';
const HOST_TAGS = new Set(`${HTML_TAGS} ${SVG_TAGS}`.split(' '));

/**
 * Vero per gli elementi HTML e SVG e per i custom element (nome con un trattino). I componenti
 * (Maiuscola, a.b, a:b) e i tag di altri renderer restano intatti.
 */
export function isHostTag(name: string): boolean {
  return HOST_TAGS.has(name) || /^[a-z][a-z0-9]*-[\w-]*$/.test(name);
}

/**
 * File di un renderer che non produce elementi del DOM (React Three Fiber, React Native...):
 * lì anche <line> o <audio> sono oggetti del renderer, e il file va lasciato com'è.
 */
export function usesForeignRenderer(code: string): boolean {
  return /['"](?:@react-three\/|react-native|@react-pdf\/|ink['"]|react-konva|@pixi\/react)/.test(code);
}

/** I plugin non agiscono nelle build di produzione né sotto i test del progetto (gli snapshot del DOM cambierebbero a ogni modifica). */
export function sourceTaggingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.NODE_ENV === 'test' || Boolean(env.VITEST) || Boolean(env.JEST_WORKER_ID);
}

function parserPlugins(filename: string): ParserPlugin[] {
  const plugins: ParserPlugin[] = ['jsx', 'decorators-legacy', 'importAttributes', 'explicitResourceManagement'];
  if (/\.(?:[cm]?ts|tsx)$/i.test(filename)) plugins.push('typescript');
  return plugins;
}

/**
 * Restituisce il sorgente con gli attributi aggiunti (e la source map), oppure null se il file
 * non contiene JSX, non si riesce a leggerlo o non c'è nulla da marcare. Non lancia mai: un
 * file che il parser non capisce prosegue invariato verso il compilatore del progetto.
 */
export function tagSource(code: string, filename: string, options: TagSourceOptions = {}): TagSourceResult | null {
  if (!code.includes('<') || !/<[a-z]/.test(code) || usesForeignRenderer(code)) return null;
  const attribute = options.attribute || SOURCE_ATTRIBUTE;
  let ast: AstNode;
  try {
    ast = parse(code, {
      sourceType: 'module',
      sourceFilename: filename,
      plugins: parserPlugins(filename),
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
    }) as unknown as AstNode;
  } catch {
    return null;
  }

  const file = sourcePath(filename, options.root);
  const out = new MagicString(code);
  let count = 0;

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const n = node as AstNode;
    if (typeof n.type !== 'string') return;
    if (n.type === 'JSXOpeningElement') {
      const name = n.name as AstNode | undefined;
      const attrs = (n.attributes as AstNode[] | undefined) ?? [];
      const tagged = attrs.some((a) => a.type === 'JSXAttribute' && (a.name as AstNode | undefined)?.name === attribute);
      if (name?.type === 'JSXIdentifier' && typeof name.name === 'string' && isHostTag(name.name) && !tagged && typeof name.end === 'number' && n.loc) {
        const value = `${file}:${n.loc.start.line}:${n.loc.start.column + 1}`.replace(/"/g, '&quot;');
        out.appendLeft(name.end, ` ${attribute}="${value}"`);
        count++;
      }
    }
    for (const key of Object.keys(n)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = n[key];
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast.program ?? ast);

  if (!count) return null;
  return { code: out.toString(), map: out.generateMap({ source: filename, includeContent: true, hires: true }), count };
}

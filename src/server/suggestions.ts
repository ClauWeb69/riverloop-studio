import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppMode, SuggestionInfo } from '../shared/protocol.js';
import { gitIgnoreStatus } from './gitignore.js';
import { t } from './i18n.js';
import { sanitizeInline } from './util.js';

/**
 * Suggerimenti per il progetto: cose che, cambiate nella sua configurazione, fanno funzionare
 * meglio Studio. Studio non le cambia mai da sé: le propone nella pagina e, con un clic, chiede
 * a Claude Code di farle (il testo della richiesta è scritto qui, non dalla pagina).
 */
export interface SuggestionContext {
  mode: AppMode;
  /** Comando con cui Studio avvia il dev server (null se non lo avvia lui). */
  devCommand: string | null;
  /** L'utente ha già detto di no alla riga nel .gitignore. */
  gitignoreDeclined: boolean;
  /** Cartella di installazione di riverloop-studio (da cui il progetto può installare i plugin). */
  studioRoot?: string;
}

/** Cartella del pacchetto: da dist/src/server oppure da src/server. */
const STUDIO_ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'bin'))) return dir;
    dir = path.dirname(dir);
  }
  return dir;
})();

const posix = (p: string) => p.replace(/\\/g, '/');

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function firstExisting(cwd: string, names: string[]): string | null {
  return names.find((n) => existsSync(path.join(cwd, n))) ?? null;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  babel?: unknown;
}

function readPackage(cwd: string): PackageJson | null {
  const text = readText(path.join(cwd, 'package.json'));
  if (!text) return null;
  try {
    const pkg = JSON.parse(text) as PackageJson;
    return pkg && typeof pkg === 'object' ? pkg : null;
  } catch {
    return null;
  }
}

/** Comando di installazione con il gestore di pacchetti del progetto. */
function installCommand(cwd: string, studioRoot: string): string {
  const from = `"${posix(studioRoot)}"`;
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return `pnpm add -D ${from}`;
  if (existsSync(path.join(cwd, 'yarn.lock'))) return `yarn add -D ${from}`;
  if (existsSync(path.join(cwd, 'bun.lockb')) || existsSync(path.join(cwd, 'bun.lock'))) return `bun add -d ${from}`;
  return `npm install --save-dev ${from}`;
}

const NEXT_CONFIGS = ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs'];
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];
const ELECTRON_VITE_CONFIGS = ['electron.vite.config.ts', 'electron.vite.config.mts', 'electron.vite.config.js', 'electron.vite.config.mjs'];
const BABEL_CONFIGS = ['.babelrc', '.babelrc.json', 'babel.config.js', 'babel.config.json', 'babel.config.cjs', 'babel.config.mjs'];

/** File e riga esatti: il plugin di build non è ancora nella configurazione del progetto. */
function sourcePlugin(cwd: string, pkg: PackageJson, studioRoot: string): SuggestionInfo | null {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  // Il plugin lavora sul JSX: senza React non serve
  if (!deps.react) return null;
  // Già attivo tramite Babel?
  if (JSON.stringify(pkg.babel ?? '').includes('riverloop-studio')) return null;
  if (BABEL_CONFIGS.some((f) => readText(path.join(cwd, f))?.includes('riverloop-studio'))) return null;

  let steps: string;
  let where: string;
  if (deps.next) {
    const config = firstExisting(cwd, NEXT_CONFIGS);
    if (config && readText(path.join(cwd, config))?.includes('riverloop-studio')) return null;
    where = config ?? 'next.config.mjs';
    steps = config ? t('suggest.source.next', { config }) : t('suggest.source.nextCreate');
  } else if (deps['electron-vite'] && firstExisting(cwd, ELECTRON_VITE_CONFIGS)) {
    const config = firstExisting(cwd, ELECTRON_VITE_CONFIGS)!;
    if (readText(path.join(cwd, config))?.includes('riverloop-studio')) return null;
    where = config;
    steps = t('suggest.source.electronVite', { config });
  } else if (deps.vite) {
    const config = firstExisting(cwd, VITE_CONFIGS);
    if (!config) return null;
    if (readText(path.join(cwd, config))?.includes('riverloop-studio')) return null;
    where = config;
    steps = t('suggest.source.vite', { config });
  } else {
    return null;
  }

  const installed = existsSync(path.join(cwd, 'node_modules', 'riverloop-studio', 'package.json'));
  const install = installCommand(cwd, studioRoot);
  const lines = [
    t('suggest.source.intro'),
    '',
    installed ? t('suggest.source.installed') : t('suggest.source.install', { command: install }),
    `2. ${steps}`,
    '',
    t('suggest.onlyThis'),
  ];
  return {
    id: 'source-plugin',
    title: t('suggest.source.title'),
    detail: t('suggest.source.detail', { file: where }) + (installed ? '' : t('suggest.source.detailInstall')),
    prompt: lines.join('\n'),
  };
}

/** Lo script "dev" di Next.js fissa la porta: Studio non può spostare il dev server se è occupata. */
function fixedDevPort(pkg: PackageJson, ctx: SuggestionContext): SuggestionInfo | null {
  if (ctx.mode !== 'web' || !ctx.devCommand || !/\bdev\b/.test(ctx.devCommand)) return null;
  const script = pkg.scripts?.dev;
  if (!script || !/\bnext\s+dev\b/.test(script)) return null;
  const m = /(?:^|\s)(?:-p|--port)(?:=|\s+)(\d{2,5})\b/.exec(script);
  if (!m) return null;
  const shown = sanitizeInline(script, 160);
  return {
    id: 'dev-port',
    title: t('suggest.devPort.title', { port: m[1] }),
    detail: t('suggest.devPort.detail', { port: m[1] }),
    prompt: [t('suggest.devPort.intro', { script: shown }), '', t('suggest.devPort.fix'), '', t('suggest.onlyThis')].join('\n'),
  };
}

/** Le annotazioni di Studio non sono ancora ignorate da git. */
function gitignore(cwd: string, ctx: SuggestionContext): SuggestionInfo | null {
  if (ctx.gitignoreDeclined || gitIgnoreStatus(cwd) !== 'not-ignored') return null;
  return {
    id: 'gitignore',
    title: t('suggest.gitignore.title'),
    detail: t('suggest.gitignore.detail'),
    prompt: [t('suggest.gitignore.prompt', { comment: t('gitignore.comment') }), '', t('suggest.onlyThis')].join('\n'),
  };
}

/** Suggerimenti validi adesso per il progetto (quelli già soddisfatti non compaiono). */
export function detectSuggestions(cwd: string, ctx: SuggestionContext): SuggestionInfo[] {
  const out: SuggestionInfo[] = [];
  const add = (make: () => SuggestionInfo | null) => {
    try {
      const s = make();
      if (s) out.push(s);
    } catch {
      /* progetto illeggibile in quel punto: niente suggerimento */
    }
  };
  const pkg = readPackage(cwd);
  if (pkg) {
    add(() => sourcePlugin(cwd, pkg, ctx.studioRoot ?? STUDIO_ROOT));
    add(() => fixedDevPort(pkg, ctx));
  }
  add(() => gitignore(cwd, ctx));
  return out;
}

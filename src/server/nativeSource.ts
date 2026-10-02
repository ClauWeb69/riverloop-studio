// File e riga probabili di un controllo di un'app nativa (modalità window). Nelle app desktop non
// c'è un attributo data-studio-src: si cerca nel codice del progetto l'AutomationId del controllo
// (in WinForms è il Name, in WPF/XAML x:Name o AutomationProperties.AutomationId, in Qt
// objectName) e, se manca, il suo testo tra virgolette. Ricerca limitata nel tempo e nel numero
// di file: è un aiuto per Claude, non un indice del progetto.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { NativeElement } from '../shared/protocol.js';
import { toPosix } from './util.js';

const SOURCE_EXT = new Set([
  '.cs',
  '.vb',
  '.xaml',
  '.axaml',
  '.fs',
  '.resx',
  '.py',
  '.ui',
  '.qml',
  '.kv',
  '.ps1',
  '.psm1',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.rc',
  '.java',
  '.kt',
  '.fxml',
  '.swift',
  '.m',
  '.mm',
  '.go',
  '.rs',
  '.dart',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.vue',
  '.svelte',
  '.html',
]);
const SKIP_DIRS = new Set([
  'node_modules',
  'bin',
  'obj',
  'dist',
  'build',
  'out',
  'target',
  'venv',
  '__pycache__',
  'Debug',
  'Release',
  'packages',
  'vendor',
  'coverage',
]);
/** AutomationId dei controlli di sistema della finestra: non dicono nulla del codice dell'app. */
const GENERIC_IDS = new Set(['Close', 'Minimize', 'Maximize', 'Restore', 'TitleBar', 'SystemMenuBar', 'MenuBar', 'Item 1', 'TextBox', 'Button']);

export interface SourceHit {
  file: string;
  line: number;
}

export interface SearchLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  budgetMs?: number;
  maxHits?: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Espressioni da cercare, dalla più precisa: AutomationId come parola, poi il testo tra virgolette. */
export function sourcePatterns(el: Pick<NativeElement, 'automationId' | 'name'>): RegExp[] {
  const out: RegExp[] = [];
  const id = el.automationId.trim();
  if (/^[A-Za-z_][\w.-]{1,79}$/.test(id) && !GENERIC_IDS.has(id) && !/^\d+$/.test(id)) out.push(new RegExp(`(?<![\\w-])${escapeRe(id)}(?![\\w-])`));
  const name = el.name.trim();
  if (name.length >= 2 && name.length <= 60 && !name.includes('\n')) out.push(new RegExp(`["'>]${escapeRe(name)}["'<]`));
  return out;
}

async function* sourceFiles(root: string, limits: Required<SearchLimits>, deadline: number): AsyncGenerator<string> {
  const queue = [root];
  let count = 0;
  while (queue.length && Date.now() < deadline) {
    const dir = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(full);
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        if (!SOURCE_EXT.has(path.extname(lower))) continue;
        if (++count > limits.maxFiles) return;
        yield full;
      }
    }
  }
}

/** Righe del progetto in cui compare il controllo (al più maxHits), con il percorso relativo. */
export async function findNativeSource(cwd: string, el: Pick<NativeElement, 'automationId' | 'name'>, opts: SearchLimits = {}): Promise<SourceHit[]> {
  const limits: Required<SearchLimits> = { maxFiles: 5000, maxFileBytes: 1_000_000, budgetMs: 1500, maxHits: 3, ...opts };
  const patterns = sourcePatterns(el);
  if (!patterns.length) return [];
  const deadline = Date.now() + limits.budgetMs;
  // Per ogni espressione, nell'ordine: se l'AutomationId si trova, il testo non serve
  const hits: SourceHit[][] = patterns.map(() => []);
  for await (const file of sourceFiles(cwd, limits, deadline)) {
    if (Date.now() > deadline) break;
    try {
      if ((await stat(file)).size > limits.maxFileBytes) continue;
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
      patterns.forEach((re, p) => {
        if (hits[p].length >= limits.maxHits) return;
        for (let i = 0; i < lines.length && hits[p].length < limits.maxHits; i++) {
          if (re.test(lines[i])) hits[p].push({ file: toPosix(path.relative(cwd, file)), line: i + 1 });
        }
      });
    } catch {
      /* file illeggibile: si passa oltre */
    }
    if (hits[0].length >= limits.maxHits) break;
  }
  return hits.find((h) => h.length) ?? [];
}

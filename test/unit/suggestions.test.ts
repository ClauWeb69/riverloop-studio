import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectSuggestions, type SuggestionContext } from '../../src/server/suggestions.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-suggest-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const STUDIO = path.join(tmp, 'riverloop studio');
const web: SuggestionContext = { mode: 'web', devCommand: 'npm run dev', gitignoreDeclined: false, studioRoot: STUDIO };

/** Crea un progetto di prova con i file indicati (percorso relativo → contenuto). */
function project(name: string, files: Record<string, string | object>): string {
  const dir = path.join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
const ids = (cwd: string, ctx = web) => detectSuggestions(cwd, ctx).map((s) => s.id);
const find = (cwd: string, id: string, ctx = web) => detectSuggestions(cwd, ctx).find((s) => s.id === id);

describe('suggerimenti per il progetto', () => {
  it('Next.js senza il plugin: propone file e riga, con installazione e modifica della configurazione', () => {
    const cwd = project('next', {
      'package.json': { dependencies: { next: '16.0.0', react: '19.0.0' }, scripts: { dev: 'next dev' } },
      'next.config.ts': 'export default {};\n',
    });
    const s = find(cwd, 'source-plugin');
    expect(s?.title).toBe('File e riga esatti per ogni elemento');
    expect(s?.detail).toContain('next.config.ts');
    expect(s?.prompt).toContain(`npm install --save-dev "${STUDIO.replace(/\\/g, '/')}"`);
    expect(s?.prompt).toContain('In next.config.ts importa withStudio da "riverloop-studio/next"');
    // l'ultima riga è testo semplice e chiede di non allargarsi
    expect(s?.prompt.split('\n').at(-1)).toBe('Non cambiare altro. Alla fine dimmi in una riga cosa hai modificato.');
    expect(ids(cwd)).toEqual(['source-plugin']);
  });

  it('già configurato (nel config o tramite Babel): nessun suggerimento', () => {
    const next = project('next-ok', {
      'package.json': { dependencies: { next: '16.0.0', react: '19.0.0' } },
      'next.config.mjs': 'import { withStudio } from "riverloop-studio/next";\nexport default withStudio({});\n',
    });
    expect(ids(next)).toEqual([]);
    const babel = project('babel-ok', {
      'package.json': { dependencies: { vite: '8.0.0', react: '19.0.0' } },
      'vite.config.ts': 'export default {};\n',
      '.babelrc': '{ "plugins": ["riverloop-studio/babel"] }',
    });
    expect(ids(babel)).toEqual([]);
  });

  it('Vite ed electron-vite: il plugin va prima di quello di React; pacchetto già installato e gestore di pacchetti', () => {
    const vite = project('vite', {
      'package.json': { devDependencies: { vite: '8.0.0', react: '19.0.0', '@vitejs/plugin-react': '6.0.0' } },
      'vite.config.ts': 'export default {};\n',
      'pnpm-lock.yaml': '',
    });
    const s = find(vite, 'source-plugin');
    expect(s?.prompt).toContain('pnpm add -D');
    expect(s?.prompt).toContain('In vite.config.ts importa il plugin (import studio from "riverloop-studio/vite") e mettilo per primo in plugins');
    const electron = project('electron-vite', {
      'package.json': { devDependencies: { 'electron-vite': '3.0.0', vite: '8.0.0', react: '19.0.0' } },
      'electron.vite.config.ts': 'export default {};\n',
      'node_modules/riverloop-studio/package.json': { name: 'riverloop-studio' },
    });
    const e = find(electron, 'source-plugin', { ...web, mode: 'electron', devCommand: null });
    expect(e?.prompt).toContain('aggiungilo ai plugins della sezione renderer');
    expect(e?.prompt).toContain('è già installato nel progetto');
    expect(e?.prompt).not.toContain('--save-dev');
  });

  it('senza React, senza package.json o senza file di configurazione: niente plugin', () => {
    expect(ids(project('vue', { 'package.json': { dependencies: { vite: '8.0.0', vue: '3.0.0' } }, 'vite.config.ts': '' }))).toEqual([]);
    expect(ids(project('vuoto', { 'README.md': 'ciao' }))).toEqual([]);
    expect(ids(project('vite-senza-config', { 'package.json': { dependencies: { vite: '8.0.0', react: '19.0.0' } } }))).toEqual([]);
    expect(ids(project('rotto', { 'package.json': '{ non json' }))).toEqual([]);
  });

  it('script "dev" di Next.js con la porta fissa: solo se Studio avvia quello script, solo in modalità web', () => {
    const files = {
      'package.json': { dependencies: { next: '16.0.0', react: '19.0.0' }, scripts: { dev: 'next dev --turbopack -p 3000' } },
      'next.config.js': 'module.exports = require("riverloop-studio/next").withStudio({});\n',
    };
    const cwd = project('next-porta', files);
    const s = find(cwd, 'dev-port');
    expect(s?.title).toBe('Lo script "dev" fissa la porta 3000');
    expect(s?.prompt).toContain('next dev --turbopack -p 3000');
    expect(ids(cwd, { ...web, devCommand: null })).toEqual([]);
    expect(ids(cwd, { ...web, devCommand: 'node server.js' })).toEqual([]);
    expect(ids(cwd, { ...web, mode: 'electron' })).toEqual([]);
    // --port=N e script senza porta
    expect(
      ids(
        project('next-porta-2', { ...files, 'package.json': { dependencies: { next: '16.0.0', react: '19.0.0' }, scripts: { dev: 'next dev --port=4000' } } }),
      ),
    ).toEqual(['dev-port']);
    expect(
      ids(project('next-libero', { ...files, 'package.json': { dependencies: { next: '16.0.0', react: '19.0.0' }, scripts: { dev: 'next dev' } } })),
    ).toEqual([]);
    // Vite non legge PORT: togliere la porta dallo script non servirebbe
    expect(ids(project('vite-porta', { 'package.json': { dependencies: { vite: '8.0.0' }, scripts: { dev: 'vite --port 5173' } } }))).toEqual([]);
  });

  it('.gitignore: proposto solo in un repository git che non ignora .claude/studio, e non dopo un no', () => {
    const repo = project('repo', { '.git/HEAD': 'ref: refs/heads/main\n', 'README.md': 'x' });
    const s = find(repo, 'gitignore');
    expect(s?.prompt).toContain('.claude/studio/');
    expect(ids(repo, { ...web, gitignoreDeclined: true })).toEqual([]);
    const ignored = project('repo-ok', { '.git/HEAD': 'ref: refs/heads/main\n', '.gitignore': '.claude/studio/\n' });
    expect(ids(ignored)).toEqual([]);
    expect(ids(project('senza-git', { 'README.md': 'x' }))).toEqual([]);
  });
});

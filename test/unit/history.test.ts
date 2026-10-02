import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProjectHistory } from '../../src/server/history.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-history-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
/** Progetto di prova con qualche file, e la sua cronologia in un archivio fuori dal progetto. */
function setup(files: Record<string, string>): {
  cwd: string;
  archive: string;
  history: ProjectHistory;
  read: (f: string) => string;
  write: (f: string, c: string) => void;
} {
  const cwd = path.join(tmp, `progetto-${++counter}`);
  const archive = path.join(tmp, `archivio-${counter}`);
  mkdirSync(archive, { recursive: true });
  const write = (f: string, c: string) => {
    mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
    writeFileSync(path.join(cwd, f), c);
  };
  for (const [f, c] of Object.entries(files)) write(f, c);
  return { cwd, archive, history: new ProjectHistory(cwd, archive), read: (f) => readFileSync(path.join(cwd, f), 'utf8'), write };
}

describe('Annulla e Ripeti delle modifiche ai file', () => {
  it('Annulla riporta i file a prima della richiesta; Ripeti rimette le modifiche', async () => {
    const p = setup({ 'src/app.tsx': 'titolo rosso\r\n', 'src/vecchio.ts': 'da cancellare\n', '.gitignore': 'segreti.env\n', 'segreti.env': 'A=1\n' });
    expect(p.history.state()).toMatchObject({ available: true, canUndo: false, canRedo: false });
    expect((await p.history.undo()).ok).toBe(false);

    await p.history.checkpoint('rendi il titolo blu');
    expect(p.history.state()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: 'rendi il titolo blu' });
    // ciò che farebbe Claude: modifica, crea, cancella (e tocca anche un file ignorato da git)
    p.write('src/app.tsx', 'titolo blu\r\n');
    p.write('src/nuovo.ts', 'creato da Claude\n');
    rmSync(path.join(p.cwd, 'src/vecchio.ts'));
    p.write('segreti.env', 'A=2\n');

    const undone = await p.history.undo();
    expect(undone).toMatchObject({ ok: true, message: 'Annullato: i file sono tornati a prima di «rendi il titolo blu».' });
    // byte per byte, fine riga compresi
    expect(p.read('src/app.tsx')).toBe('titolo rosso\r\n');
    expect(existsSync(path.join(p.cwd, 'src/nuovo.ts'))).toBe(false);
    expect(p.read('src/vecchio.ts')).toBe('da cancellare\n');
    // i file ignorati dal progetto non vengono né salvati né ripristinati
    expect(p.read('segreti.env')).toBe('A=2\n');
    expect(p.history.state()).toMatchObject({ canRedo: true, redoLabel: 'rendi il titolo blu' });
    expect(p.history.takeNotice()).toContain('Rileggi i file');
    expect(p.history.takeNotice()).toBeNull();

    expect((await p.history.redo()).ok).toBe(true);
    expect(p.read('src/app.tsx')).toBe('titolo blu\r\n');
    expect(p.read('src/nuovo.ts')).toBe('creato da Claude\n');
    expect(existsSync(path.join(p.cwd, 'src/vecchio.ts'))).toBe(false);
    expect(p.history.state()).toMatchObject({ canUndo: true, canRedo: false });
    p.history.dispose();
  }, 30000);

  it('più richieste: si torna indietro e avanti un passo alla volta', async () => {
    const p = setup({ 'a.txt': '0\n' });
    await p.history.checkpoint('prima richiesta');
    p.write('a.txt', '1\n');
    await p.history.checkpoint('seconda richiesta');
    p.write('a.txt', '2\n');
    expect((await p.history.undo()).message).toContain('«seconda richiesta»');
    expect(p.read('a.txt')).toBe('1\n');
    expect(p.history.state().undoLabel).toBe('prima richiesta');
    expect((await p.history.undo()).message).toContain('«prima richiesta»');
    expect(p.read('a.txt')).toBe('0\n');
    expect((await p.history.undo()).ok).toBe(false);
    expect((await p.history.redo()).ok).toBe(true);
    expect(p.read('a.txt')).toBe('1\n');
    expect((await p.history.redo()).ok).toBe(true);
    expect(p.read('a.txt')).toBe('2\n');
    expect((await p.history.redo()).ok).toBe(false);
    p.history.dispose();
  }, 30000);

  it('dopo un Annulla, nuove modifiche o una nuova richiesta tolgono il Ripeti (non si cancella lavoro)', async () => {
    const p = setup({ 'a.txt': '0\n' });
    await p.history.checkpoint('richiesta');
    p.write('a.txt', '1\n');
    await p.history.undo();
    p.write('a.txt', 'scritto a mano dopo\n');
    const redo = await p.history.redo();
    expect(redo.ok).toBe(false);
    expect(redo.message).toContain('modificati di nuovo');
    expect(p.read('a.txt')).toBe('scritto a mano dopo\n');
    expect(p.history.state().canRedo).toBe(false);
    // una nuova richiesta riparte da qui
    await p.history.checkpoint('altra richiesta');
    p.write('a.txt', '3\n');
    await p.history.undo();
    expect(p.read('a.txt')).toBe('scritto a mano dopo\n');
    // una richiesta che non cambia nulla non aggiunge un passo vuoto
    await p.history.checkpoint('domanda senza modifiche');
    await p.history.checkpoint('richiesta vera');
    p.write('a.txt', '4\n');
    await p.history.undo();
    expect(p.read('a.txt')).toBe('scritto a mano dopo\n');
    p.history.dispose();
  }, 30000);

  it("non tocca il repository git del progetto, e tiene l'archivio fuori dal progetto", async () => {
    const p = setup({ 'a.txt': '0\n' });
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], {
        cwd: p.cwd,
        encoding: 'utf8',
      }).trim();
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'inizio');
    const head = git('rev-parse', 'HEAD');
    const entries = readdirSync(p.cwd).sort();

    await p.history.checkpoint('richiesta');
    p.write('a.txt', '1\n');
    // per il repository del progetto è una normale modifica non preparata: niente commit, niente staging
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('diff', '--cached', '--name-only')).toBe('');
    expect(git('status', '--porcelain')).toBe('M a.txt');
    await p.history.undo();
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('status', '--porcelain')).toBe('');
    expect(git('log', '--oneline').split('\n')).toHaveLength(1);
    expect(git('for-each-ref')).toContain('refs/heads/');
    expect(git('for-each-ref').split('\n')).toHaveLength(1);
    // nessun file nuovo nel progetto: le fotografie stanno nell'archivio di Studio
    expect(readdirSync(p.cwd).sort()).toEqual(entries);
    expect(readdirSync(p.archive)).toHaveLength(1);
    p.history.dispose();
    expect(readdirSync(p.archive)).toHaveLength(0);
  }, 30000);
});

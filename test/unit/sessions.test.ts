import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { addRecent, launchArgs, listInstances, readRecent, registerInstance, unregisterInstance } from '../../src/server/projects.js';
import { readConversationId, withoutResumeArgs } from '../../src/server/pty.js';
import { MAX_SESSIONS, SessionManager } from '../../src/server/sessions.js';
import { runDir } from '../../src/server/util.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-sessions-test-'));
// Registro, porte e log dei test separati da quelli dell'utente
process.env.RIVERLOOP_STUDIO_RUN_DIR = path.join(tmp, 'run');
afterAll(() => {
  delete process.env.RIVERLOOP_STUDIO_RUN_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

const manager = () => new SessionManager({ command: { path: '/bin/true', viaCmd: false }, extraArgs: ['--model', 'x'], cwd: tmp, permissions: 'ask' });

describe('sessioni di Claude Code', () => {
  it("apre più sessioni numerate e non chiude l'ultima", async () => {
    const m = manager();
    const a = m.create();
    const b = m.create({ resumeFirst: true });
    expect(m.list().map((s) => [s.id, s.name])).toEqual([
      ['1', 'Claude 1'],
      ['2', 'Claude 2'],
    ]);
    expect(m.get('2')).toBe(b);
    expect(await m.close('1')).toBe(true);
    expect(m.first()).toBe(b);
    expect(await m.close('2')).toBe(false);
    expect(m.size).toBe(1);
    expect(a.listenerCount('state')).toBe(0);
  });

  it('rinomina le schede e ritrova il nome riprendendo la stessa conversazione', () => {
    const conversation = '0b9c4f3e-2a1d-4c6b-9e8f-1a2b3c4d5e6f';
    let saved: Record<string, string> = {};
    const m = new SessionManager({
      command: { path: '/bin/true', viaCmd: false },
      extraArgs: [],
      cwd: tmp,
      permissions: 'ask',
      onNamesChange: (names) => (saved = names),
    });
    const a = m.create();
    // Nome scelto prima che si conosca la conversazione: viene ricordato appena la si scopre
    expect(m.rename('1', '  Bug \u0007 urgenti  ')).toBe(true);
    expect(m.list()[0]).toMatchObject({ name: 'Bug urgenti', renamed: true });
    expect(saved).toEqual({});
    a.conversationId = conversation;
    a.emit('conversation', conversation);
    expect(saved).toEqual({ [conversation]: 'Bug urgenti' });
    // Nome vuoto: si torna a "Claude <n>" e si dimentica
    m.rename('1', '   ');
    expect(m.list()[0]).toMatchObject({ name: 'Claude 1', renamed: false });
    expect(saved).toEqual({});
    expect(m.rename('9', 'x')).toBe(false);

    // Un'altra esecuzione di Studio: la scheda che riprende la conversazione ritrova il nome
    const next = new SessionManager({
      command: { path: '/bin/true', viaCmd: false },
      extraArgs: [],
      cwd: tmp,
      permissions: 'ask',
      savedNames: { [conversation]: 'UI' },
    });
    const b = next.create();
    expect(next.list()[0].name).toBe('Claude 1');
    b.conversationId = conversation;
    b.emit('conversation', conversation);
    expect(next.list()[0]).toMatchObject({ name: 'UI', renamed: true });
  });

  it('ha un limite di sessioni per progetto', () => {
    const m = manager();
    for (let i = 0; i < MAX_SESSIONS; i++) m.create();
    expect(() => m.create()).toThrow(/al massimo/);
  });

  it("i riavvii riprendono la conversazione della scheda, non l'ultima della cartella", () => {
    const m = manager();
    const s = m.create() as unknown as { argsFor(mode: string): string[]; conversationId: string | null };
    expect(s.argsFor('continue')).toEqual(['--continue', '--model', 'x']);
    s.conversationId = '11111111-2222-4333-8444-555555555555';
    expect(s.argsFor('continue')).toEqual(['--resume', '11111111-2222-4333-8444-555555555555', '--model', 'x']);
    expect(s.argsFor('resume')).toEqual(['--resume', '--model', 'x']);
    expect(s.argsFor('new')).toEqual(['--model', 'x']);
  });

  it('le schede aperte dalla pagina non ereditano --continue/--resume da --claude-args', () => {
    expect(withoutResumeArgs(['--continue', '--model', 'x', '-r', 'abc', '--resume=1', '-c', '--verbose'])).toEqual(['--model', 'x', '--verbose']);
    const m = new SessionManager({ command: { path: '/bin/true', viaCmd: false }, extraArgs: ['--continue', '--model', 'x'], cwd: tmp, permissions: 'ask' });
    const first = m.create({ inheritResumeArgs: true }) as unknown as { argsFor(mode: string): string[] };
    const other = m.create() as unknown as { argsFor(mode: string): string[] };
    expect(first.argsFor('initial')).toEqual(['--continue', '--model', 'x']);
    expect(other.argsFor('initial')).toEqual(['--model', 'x']);
  });

  it('una scheda chiusa non riparte (neanche per un riavvio già in corso)', async () => {
    const m = manager();
    m.create();
    const s = m.create();
    expect(await m.close(s.id)).toBe(true);
    expect(s.closed).toBe(true);
    await s.start('continue');
    expect(s.state).toBe('idle');
    expect(s.pid).toBeNull();
  });

  it("le nuove sessioni partono con l'ultima scelta di permessi", () => {
    const m = manager();
    const first = m.create();
    first.emit('permissions', 'skip');
    expect(m.create().permissions).toBe('skip');
  });

  it('legge la conversazione in corso dal file di Claude Code', async () => {
    const dir = path.join(tmp, 'claude');
    mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      writeFileSync(path.join(dir, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: '9a4ca3c3-1111-4222-8333-444455556666' }));
      writeFileSync(path.join(dir, 'sessions', '4343.json'), JSON.stringify({ pid: 9999, sessionId: '9a4ca3c3-1111-4222-8333-444455556666' }));
      writeFileSync(path.join(dir, 'sessions', '4444.json'), JSON.stringify({ pid: 4444, sessionId: '--dangerously-skip-permissions' }));
      expect(await readConversationId(4242)).toBe('9a4ca3c3-1111-4222-8333-444455556666');
      expect(await readConversationId(4343)).toBeNull();
      expect(await readConversationId(4444)).toBeNull();
      expect(await readConversationId(4545)).toBeNull();
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
});

describe('progetti aperti su questo computer', () => {
  it("la cartella di lavoro è privata dell'utente", () => {
    const dir = runDir('instances');
    expect(dir.startsWith(path.join(tmp, 'run'))).toBe(true);
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('registra questa istanza e la elenca come corrente', async () => {
    registerInstance({ project: 'prova', cwd: tmp, studioPort: 1, url: 'http://127.0.0.1:1/#t=x', token: 'x', startedAt: Date.now() });
    try {
      const mine = (await listInstances()).find((i) => i.pid === process.pid);
      expect(mine?.current).toBe(true);
      expect(mine?.project).toBe('prova');
    } finally {
      unregisterInstance();
    }
    expect((await listInstances()).some((i) => i.pid === process.pid)).toBe(false);
  });

  it('toglie le voci rimaste da istanze chiuse male, ma non quelle solo lente', async () => {
    const dir = runDir('instances');
    const net = await import('node:net');
    // porta chiusa: nessuno risponde, la voce è da togliere
    const closed = await new Promise<number>((resolve) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port;
        srv.close(() => resolve(port));
      });
    });
    // istanza "sospesa": accetta la connessione ma non risponde in tempo
    const sockets: import('node:net').Socket[] = [];
    const slow = net.createServer((sock) => sockets.push(sock));
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
    const slowPort = (slow.address() as { port: number }).port;
    const entry = (pid: number, port: number) => ({ pid, project: `p${port}`, cwd: `/x/${port}`, studioPort: port, url: 'u', token: 't', startedAt: 1 });
    // pid vivo ma non nostro: il processo che ha avviato i test
    writeFileSync(path.join(dir, '1000001.json'), JSON.stringify(entry(process.ppid, closed)));
    writeFileSync(path.join(dir, '1000002.json'), JSON.stringify(entry(process.ppid, slowPort)));
    try {
      const list = await listInstances();
      expect(list.some((i) => i.studioPort === closed)).toBe(false);
      expect(list.some((i) => i.studioPort === slowPort)).toBe(true);
      expect(() => statSync(path.join(dir, '1000001.json'))).toThrow();
      expect(statSync(path.join(dir, '1000002.json')).isFile()).toBe(true);
    } finally {
      rmSync(path.join(dir, '1000001.json'), { force: true });
      rmSync(path.join(dir, '1000002.json'), { force: true });
      sockets.forEach((s) => s.destroy());
      slow.close();
    }
  });

  it('ricorda i progetti recenti, senza doppioni, dal più recente', () => {
    process.env.RIVERLOOP_STUDIO_CONFIG_DIR = path.join(tmp, 'studio');
    try {
      addRecent('/lavoro/uno');
      addRecent('/lavoro/due');
      addRecent('/lavoro/uno');
      expect(readRecent()).toEqual([
        { cwd: '/lavoro/uno', project: 'uno' },
        { cwd: '/lavoro/due', project: 'due' },
      ]);
    } finally {
      delete process.env.RIVERLOOP_STUDIO_CONFIG_DIR;
    }
  });

  it('ricorda come è stato avviato un progetto, per riaprirlo allo stesso modo', () => {
    process.env.RIVERLOOP_STUDIO_CONFIG_DIR = path.join(tmp, 'studio-launch');
    try {
      addRecent('/lavoro/app', { mode: 'electron', appCmd: 'npm run electron', cdpPort: 9333, port: 99999 } as never);
      addRecent('/lavoro/web');
      const [web, app] = readRecent();
      expect(web).toEqual({ cwd: '/lavoro/web', project: 'web' });
      // valori fuori intervallo scartati
      expect(app.launch).toEqual({ mode: 'electron', appCmd: 'npm run electron', cdpPort: 9333 });
      expect(launchArgs(app.launch)).toEqual(['--mode', 'electron', '--app-cmd', 'npm run electron', '--cdp-port', '9333']);
      expect(launchArgs(undefined)).toEqual([]);
    } finally {
      delete process.env.RIVERLOOP_STUDIO_CONFIG_DIR;
    }
  });
});

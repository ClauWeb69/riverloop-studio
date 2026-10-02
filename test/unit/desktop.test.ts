import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { composePrompt, normalizeAnnotation, parseRequest, saveAnnotations } from '../../src/server/annotations.js';
import { isAppPage } from '../../src/server/cdp.js';
import { closeTargets, DesktopApp } from '../../src/server/desktop.js';
import { electronEnv, expandAppCommand, keyParams, mouseParams } from '../../src/server/electron.js';
import { hookCommand, hookPath, hookSettings, IdleTracker, mergeSettings, prepareHookSettings } from '../../src/server/hooks.js';
import { isAlive } from '../../src/server/util.js';
import { imageSize, processTree } from '../../src/server/wincapture.js';
import { MOD_CTRL, MOD_META, MOD_SHIFT, type AnnotationData, type NativeElement } from '../../src/shared/protocol.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-desktop-test-'));
process.env.RIVERLOOP_STUDIO_RUN_DIR = path.join(tmp, 'run');
afterAll(() => {
  delete process.env.RIVERLOOP_STUDIO_RUN_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

// PNG 1x1 valido
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

const button: NativeElement = {
  role: 'Button',
  name: 'Salva',
  automationId: 'btnSalva',
  className: 'WindowsForms10.BUTTON',
  framework: 'WinForm',
  path: ['Window «Clienti»', 'ToolBar'],
  rect: { x: 281, y: 103, width: 110, height: 32 },
};

function windowAnnotation(partial: Partial<AnnotationData> = {}): AnnotationData {
  return {
    id: 1,
    kind: 'element',
    comment: 'pulsante più largo',
    url: 'Clienti',
    title: 'Clienti',
    viewport: { width: 522, height: 392, scrollX: 0, scrollY: 0, dpr: 1 },
    selector: null,
    label: 'Button «Salva»',
    html: null,
    text: 'Salva',
    styles: null,
    rect: { x: 281, y: 103, width: 110, height: 32 },
    viewportRect: { x: 281, y: 103, width: 110, height: 32 },
    anchor: { selector: null, offsetX: 281, offsetY: 103 },
    surface: 'window',
    native: button,
    screenshot: PNG,
    context: 'f1',
    ...partial,
  };
}

describe('app desktop: messaggio per Claude', () => {
  it('finestra nativa: elemento, posizione nella finestra e finestra intera', () => {
    const area = windowAnnotation({
      id: 2,
      kind: 'area',
      comment: 'righe più alte',
      rect: { x: 27, y: 153, width: 220, height: 64 },
      viewportRect: { x: 27, y: 153, width: 220, height: 64 },
      native: null,
    });
    const prompt = composePrompt(
      {
        annotations: [windowAnnotation(), area],
        screenshots: new Map([
          [1, 'a/1.png'],
          [2, 'a/2.png'],
        ]),
        jsonPath: 'a/x.json',
        contexts: new Map([['f1', 'a/x-finestra-1.png']]),
      },
      '/progetto',
    );
    const lines = prompt.split('\n');
    expect(lines[0]).toBe("Modifiche richieste sulla finestra «Clienti» dell'app desktop (522×392 px):");
    expect(prompt).toContain('1. Elemento `Button «Salva»` (AutomationId `btnSalva`, classe `WindowsForms10.BUTTON`, WinForm)');
    expect(prompt).toContain('   Posizione nella finestra: x 281–391, y 103–135 px (in alto al centro)');
    expect(prompt).toContain('   Si trova: dentro Window «Clienti» > ToolBar');
    expect(prompt).toContain('2. Zona di 220×64 px (nella finestra: a sinistra, a metà altezza)');
    expect(prompt).toContain("   Posizione nella finestra: x 27–247, y 153–217 px (dall'angolo in alto a sinistra)");
    expect(prompt).toContain('Finestra intera con le annotazioni 1, 2: @a/x-finestra-1.png');
    expect(prompt).toContain("Dettagli completi (posizione, elementi dell'interfaccia): @a/x.json");
    // niente dati da pagina web
    expect(prompt).not.toContain('viewport');
    expect(prompt).not.toContain('pagina');
    // l'ultima riga resta testo semplice (non un percorso @...)
    expect(lines.at(-1)).toBe('Negli screenshot ogni annotazione è evidenziata con il suo numero.');
  });

  it('una zona sopra un elemento nativo lo nomina', () => {
    const drawing = windowAnnotation({
      kind: 'drawing',
      path: [
        [0, 0],
        [40, 4],
      ],
      rect: { x: 30, y: 97, width: 80, height: 6 },
      viewportRect: { x: 30, y: 97, width: 80, height: 6 },
    });
    const prompt = composePrompt({ annotations: [drawing], screenshots: new Map([[1, 'a/1.png']]), jsonPath: 'a/x.json' }, '/progetto');
    expect(prompt).toContain('1. Disegno su una zona di 80×6 px (nella finestra: in alto a sinistra)');
    expect(prompt).toContain("   Sopra l'elemento: `Button «Salva»` (AutomationId `btnSalva`");
  });

  it('app Chromium: finestra e pagina, con i dati del DOM', () => {
    const a: AnnotationData = {
      ...windowAnnotation({ native: undefined, context: undefined }),
      surface: 'electron',
      url: '/index.html#/clienti',
      title: 'Gestionale',
      selector: '#title',
      label: 'h1#title',
      text: 'Clienti',
      viewport: { width: 884, height: 601, scrollX: 0, scrollY: 0, dpr: 1 },
    };
    const prompt = composePrompt({ annotations: [a], screenshots: new Map([[1, 'a/1.png']]), jsonPath: 'a/x.json' }, '/progetto');
    expect(prompt.split('\n')[0]).toBe("Modifiche richieste sulla finestra «Gestionale» dell'app desktop, pagina /index.html#/clienti (viewport 884×601):");
    expect(prompt).toContain('1. Elemento `#title` — testo "Clienti"');
    expect(prompt).toContain('Dettagli completi (HTML, stili, posizione): @a/x.json');
  });

  it('valida superficie, elemento nativo e immagini della finestra', () => {
    const clean = normalizeAnnotation({
      ...windowAnnotation(),
      native: { ...button, role: 'B'.repeat(200), path: ['a', 5, 'b'], extra: 'x' },
      context: '../../etc',
    });
    expect(clean.surface).toBe('window');
    expect(clean.native?.role).toHaveLength(60);
    expect(clean.native?.path).toEqual(['a', 'b']);
    expect(clean.context).toBeNull();
    // superficie sconosciuta o pagina web: niente dati nativi
    const web = normalizeAnnotation({ ...windowAnnotation(), surface: 'altro' });
    expect(web.surface).toBeUndefined();
    expect(web.native).toBeUndefined();
    expect(web.context).toBeUndefined();
    const request = parseRequest({ annotations: [windowAnnotation()], contexts: [{ id: 'f1', image: PNG }, { id: 'no/..', image: PNG }, { id: 'f2' }] });
    expect(request.contexts).toEqual([{ id: 'f1', image: PNG }]);
  });

  it('salva la finestra intera accanto agli screenshot, solo se usata', async () => {
    const cwd = path.join(tmp, 'progetto');
    const request = parseRequest({
      annotations: [windowAnnotation()],
      contexts: [
        { id: 'f1', image: PNG },
        { id: 'nonusata', image: PNG },
      ],
    });
    const saved = await saveAnnotations(cwd, request);
    const files = readdirSync(path.join(cwd, '.claude', 'studio', 'annotations'));
    expect(files.filter((f) => f.includes('-finestra-'))).toHaveLength(1);
    expect(saved.prompt).toContain("Finestra intera con l'annotazione 1: @.claude/studio/annotations/");
    const json = JSON.parse(readFileSync(path.join(cwd, saved.jsonPath), 'utf8'));
    expect(json.annotations[0].windowScreenshot).toMatch(/-finestra-1\.png$/);
    expect(json.annotations[0].native.automationId).toBe('btnSalva');
    expect(json.annotations[0].context).toBeUndefined();
  });
});

describe('modalità electron: input e avvio', () => {
  it('mouse: clic, trascinamento e pulsanti', () => {
    const base = { type: 'mouse' as const, x: 10.26, y: 20, button: 0, buttons: 1, clicks: 2, mods: MOD_SHIFT };
    expect(mouseParams({ ...base, action: 'down' })).toMatchObject({
      type: 'mousePressed',
      x: 10.3,
      y: 20,
      button: 'left',
      buttons: 1,
      clickCount: 2,
      modifiers: MOD_SHIFT,
    });
    expect(mouseParams({ ...base, action: 'up', button: 2, buttons: 0 })).toMatchObject({ type: 'mouseReleased', button: 'right', clickCount: 2 });
    // durante un trascinamento conta il pulsante tenuto premuto
    expect(mouseParams({ ...base, action: 'move', buttons: 1 })).toMatchObject({ type: 'mouseMoved', button: 'left', clickCount: 0 });
    expect(mouseParams({ ...base, action: 'move', buttons: 0 })).toMatchObject({ button: 'none' });
  });

  it('tastiera: testo, Invio, scorciatoie', () => {
    const key = { type: 'key' as const, action: 'down' as const, code: 'KeyA', keyCode: 65, mods: 0, repeat: false, location: 0 };
    expect(keyParams({ ...key, key: 'a' }, 'win32')).toMatchObject({ type: 'keyDown', text: 'a', key: 'a', windowsVirtualKeyCode: 65 });
    expect(keyParams({ ...key, key: 'è' }, 'win32')).toMatchObject({ type: 'keyDown', text: 'è' });
    expect(keyParams({ ...key, key: 'Enter', code: 'Enter', keyCode: 13 }, 'win32')).toMatchObject({ type: 'keyDown', text: '\r' });
    // con Ctrl il tasto non scrive: è una scorciatoia dell'app
    const ctrlA = keyParams({ ...key, key: 'a', mods: MOD_CTRL }, 'win32');
    expect(ctrlA).toMatchObject({ type: 'rawKeyDown', modifiers: MOD_CTRL });
    expect(ctrlA.text).toBeUndefined();
    expect(ctrlA.commands).toBeUndefined();
    expect(keyParams({ ...key, key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, 'win32')).toMatchObject({ type: 'rawKeyDown' });
    expect(keyParams({ ...key, key: 'a', action: 'up' }, 'win32')).toMatchObject({ type: 'keyUp' });
    // su macOS le scorciatoie di modifica vanno indicate come comandi
    expect(keyParams({ ...key, key: 'v', mods: MOD_META }, 'darwin').commands).toEqual(['paste']);
    expect(keyParams({ ...key, key: 'z', mods: MOD_META | MOD_SHIFT }, 'darwin').commands).toEqual(['redo']);
  });

  it("ambiente dell'app: hook di Electron, electron-vite e WebView2, senza perdere ciò che c'era", () => {
    const env = electronEnv(9333, { NODE_OPTIONS: '--max-old-space-size=4096', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--lang=it' });
    expect(env.NODE_OPTIONS).toMatch(/^--max-old-space-size=4096 --require ".*electron-hook\.cjs"$/);
    expect(env.NODE_OPTIONS).not.toContain('\\');
    expect(env.RIVERLOOP_STUDIO_CDP_PORT).toBe('9333');
    // la finestra dell'app resta a icona, a meno che non si chieda quella normale
    expect(env.RIVERLOOP_STUDIO_APP_WINDOW).toBe('background');
    expect(electronEnv(9333, {}, 'normal').RIVERLOOP_STUDIO_APP_WINDOW).toBe('normal');
    expect(env.REMOTE_DEBUGGING_PORT).toBe('9333');
    expect(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).toMatch(/^--lang=it --remote-debugging-port=9333 /);
    // avviato da un'altra istanza di Studio: l'hook non si aggiunge due volte
    expect(electronEnv(9334, { NODE_OPTIONS: env.NODE_OPTIONS }).NODE_OPTIONS).toBe(env.NODE_OPTIONS);
    expect(expandAppCommand('electron . --remote-debugging-port={port}', 9333)).toBe('electron . --remote-debugging-port=9333');
  });

  it("le pagine dell'app, non DevTools né estensioni", () => {
    const t = (url: string, type = 'page') => ({ id: '1', type, title: '', url, webSocketDebuggerUrl: 'ws://127.0.0.1:1/x' });
    expect(isAppPage(t('file:///C:/app/index.html'))).toBe(true);
    expect(isAppPage(t('http://localhost:5173/'))).toBe(true);
    expect(isAppPage(t('devtools://devtools/bundled/inspector.html'))).toBe(false);
    expect(isAppPage(t('chrome-extension://abc/background.html'))).toBe(false);
    expect(isAppPage(t('http://localhost:5173/', 'service_worker'))).toBe(false);
    expect(isAppPage({ ...t('http://localhost/'), webSocketDebuggerUrl: undefined })).toBe(false);
  });
});

describe('fine risposta di Claude Code (hook)', () => {
  it('comando e impostazioni degli hook', () => {
    // Solo "node" e lo script tra virgolette: così vale in bash, cmd e PowerShell
    const cmd = hookCommand('G:\\Studio con spazi\\dist\\bin\\hook.js');
    expect(cmd).toBe('node "G:/Studio con spazi/dist/bin/hook.js"');
    // il Node che esegue Studio finisce in fondo al PATH di claude, senza scavalcare quello dell'utente
    // Percorsi del sistema su cui girano i test (C:\... su Windows, /... altrove)
    const sep = path.delimiter;
    const dir = (name: string) => path.join(path.parse(process.cwd()).root, name);
    const added = hookPath({ Path: [dir('altro'), dir('bin')].join(sep) }, path.join(dir('nodejs'), 'node.exe'));
    expect(added.name).toBe('Path');
    expect(added.value.split(sep)).toEqual([dir('altro'), dir('bin'), dir('nodejs')]);
    expect(hookPath({ PATH: [dir('nodejs'), dir('bin')].join(sep) }, path.join(dir('nodejs'), 'node.exe')).value.split(sep)).toEqual([
      dir('nodejs'),
      dir('bin'),
    ]);
    const settings = hookSettings(cmd);
    expect(settings.hooks.Stop[0].hooks[0]).toMatchObject({ type: 'command', command: cmd });
    expect(settings.hooks.PostToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit|Bash');
  });

  it("unisce le impostazioni dell'utente senza sostituirle", () => {
    const user = { model: 'sonnet', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mio' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [] }] } };
    const merged = mergeSettings(user, hookSettings('studio')) as { model: string; hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(merged.model).toBe('sonnet');
    expect(merged.hooks.Stop.map((e) => e.hooks[0].command)).toEqual(['echo mio', 'studio']);
    expect(merged.hooks.PreToolUse).toHaveLength(1);
    expect(merged.hooks.PostToolUse).toHaveLength(1);
  });

  it('prepara il file per --settings, tenendo quello indicato in --claude-args', () => {
    const userFile = path.join(tmp, 'mie.json');
    writeFileSync(userFile, JSON.stringify({ env: { A: '1' } }));
    const fromFile = prepareHookSettings(['--model', 'opus', '--settings', userFile], tmp);
    expect(fromFile.args.slice(0, 1)).toEqual(['--settings']);
    expect(fromFile.args.slice(2)).toEqual(['--model', 'opus']);
    const written = JSON.parse(readFileSync(fromFile.file, 'utf8'));
    expect(written.env).toEqual({ A: '1' });
    expect(written.hooks.Stop).toHaveLength(1);
    const inline = prepareHookSettings(['--settings={"permissions":{"allow":["Read"]}}'], tmp);
    expect(inline.args).toHaveLength(2);
    expect(JSON.parse(readFileSync(inline.file, 'utf8')).permissions.allow).toEqual(['Read']);
  });

  it('una risposta conta come "con modifiche" solo se uno strumento ha scritto o eseguito', () => {
    const idle = new IdleTracker();
    expect(idle.authorized(idle.token)).toBe(true);
    expect(idle.authorized(`${idle.token}x`)).toBe(false);
    expect(idle.authorized(undefined)).toBe(false);
    expect(idle.record('Stop', '1')).toBe('unchanged');
    expect(idle.record('PostToolUse', '1')).toBeNull();
    // ogni sessione ha il suo stato
    expect(idle.record('Stop', '2')).toBe('unchanged');
    expect(idle.record('Stop', '1')).toBe('changed');
    expect(idle.record('Stop', '1')).toBe('unchanged');
    expect(idle.env(4700, '3')).toMatchObject({
      RIVERLOOP_STUDIO_HOOK_URL: 'http://127.0.0.1:4700/api/hook',
      RIVERLOOP_STUDIO_HOOK_TOKEN: idle.token,
      RIVERLOOP_STUDIO_SESSION: '3',
    });
    const { name, value } = hookPath();
    expect(idle.env(4700, '3')[name]).toBe(value);
    expect(value.split(path.delimiter)).toContain(path.dirname(process.execPath));
  });
});

describe('modalità window: cattura', () => {
  it('legge le dimensioni di PNG e JPEG', () => {
    expect(imageSize(Buffer.from(PNG.split(',')[1], 'base64'))).toEqual({ width: 1, height: 1 });
    // JPEG minimo: SOI, APP0 (16 byte), SOF0 con 300×200
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c, 0x03]),
      Buffer.alloc(12),
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 300, height: 200 });
    expect(imageSize(Buffer.from("non è un'immagine"))).toBeNull();
  });

  it("albero dei processi dell'app", () => {
    const parents = new Map([
      [10, 1],
      [11, 10],
      [12, 11],
      [20, 1],
      [21, 20],
    ]);
    expect([...processTree(10, parents)].sort()).toEqual([10, 11, 12]);
    expect([...processTree(99, parents)]).toEqual([99]);
  });

  it('chiusura con garbo: solo il processo principale di ogni programma, mai gli ausiliari né la console', () => {
    // npm start → cmd → node (cli di electron) → electron principale → electron ausiliari
    const rows = [
      { pid: 100, parent: 1, name: 'cmd.exe' },
      { pid: 101, parent: 100, name: 'conhost.exe' },
      { pid: 102, parent: 100, name: 'node.exe' },
      { pid: 103, parent: 102, name: 'cmd.exe' },
      { pid: 104, parent: 103, name: 'node.exe' },
      { pid: 105, parent: 104, name: 'electron.exe' },
      { pid: 106, parent: 105, name: 'electron.exe' },
      { pid: 107, parent: 105, name: 'Electron.exe' },
      { pid: 200, parent: 1, name: 'electron.exe' },
      { pid: 201, parent: 200, name: 'electron.exe' },
    ];
    expect(closeTargets(100, rows).sort()).toEqual([100, 102, 103, 104, 105]);
    // App nativa a processo singolo avviata dalla shell
    expect(
      closeTargets(300, [
        { pid: 300, parent: 1, name: 'cmd.exe' },
        { pid: 301, parent: 300, name: 'app.exe' },
      ]).sort(),
    ).toEqual([300, 301]);
    expect(closeTargets(999, rows)).toEqual([]);
  });
});

describe("processo dell'app desktop", () => {
  it('avvia, segnala lo stato, raccoglie il log e chiude tutto', async () => {
    const script = path.join(tmp, 'app.mjs');
    writeFileSync(script, "console.log('app pronta'); setInterval(() => {}, 1000);\n");
    const app = new DesktopApp({ command: `"${process.execPath}" "${script}"`, cwd: tmp, echo: false });
    const states: string[] = [];
    app.on('status', (s: { state: string }) => states.push(s.state));
    expect(app.managed).toBe(true);
    app.start();
    expect(app.state).toBe('starting');
    const pid = app.pid;
    expect(pid).toBeTypeOf('number');
    await expect.poll(() => app.status().log.join('\n'), { timeout: 10000 }).toContain('app pronta');
    app.setReady(true);
    expect(app.state).toBe('running');
    await app.stop(2000);
    expect(isAlive(pid as number)).toBe(false);
    expect(states).toContain('running');
    // un'app esterna (--no-dev) non viene mai avviata né chiusa da Studio
    const external = new DesktopApp({ command: null, cwd: tmp });
    expect(external.managed).toBe(false);
    external.setReady(true);
    expect(external.state).toBe('external');
    external.setReady(false);
    expect(external.state).toBe('unreachable');
  }, 20000);

  it("segnala l'uscita dell'app con il suo codice", async () => {
    const app = new DesktopApp({ command: `"${process.execPath}" -e "process.exit(3)"`, cwd: tmp, echo: false });
    const exited = new Promise<number | null>((resolve) => app.on('exit', resolve));
    app.start();
    expect(await exited).toBe(3);
    expect(app.state).toBe('exited');
    expect(app.status().exitCode).toBe(3);
  }, 15000);
});

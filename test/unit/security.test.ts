import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { composePrompt, studioDir } from '../../src/server/annotations.js';
import { isLocalDebuggerUrl } from '../../src/server/cdp.js';
import { readProjectState } from '../../src/server/state.js';
import { readUserProjectState, updateUserProjectState } from '../../src/server/userState.js';
import { forAppOverlay } from '../../src/web/surface.js';
import type { AnnotationData } from '../../src/shared/protocol.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-security-'));
process.env.RIVERLOOP_STUDIO_CONFIG_DIR = path.join(tmp, 'config');
afterAll(() => {
  delete process.env.RIVERLOOP_STUDIO_CONFIG_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

function annotation(partial: Partial<AnnotationData> = {}): AnnotationData {
  return {
    id: 1,
    kind: 'element',
    comment: 'guarda @src/app.tsx',
    url: '/',
    title: 'Pagina',
    viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    selector: 'main > h1',
    label: 'h1',
    html: '<h1>x</h1>',
    text: 'x',
    styles: {},
    rect: { x: 0, y: 0, width: 10, height: 10 },
    viewportRect: { x: 0, y: 0, width: 10, height: 10 },
    anchor: { selector: 'main > h1', offsetX: 0, offsetY: 0 },
    screenshot: null,
    ...partial,
  };
}

describe('permessi di Claude Code: mai decisi dai file del progetto', () => {
  it('state.json del progetto con "skip" viene ignorato; la scelta sta nella configurazione utente', async () => {
    const project = path.join(tmp, 'progetto-permessi');
    mkdirSync(path.join(project, '.claude', 'studio'), { recursive: true });
    writeFileSync(path.join(project, '.claude', 'studio', 'state.json'), JSON.stringify({ permissions: 'skip', restartOnIdle: true }));
    const state = await readProjectState(project);
    expect(state).toEqual({ restartOnIdle: true });
    expect(await readUserProjectState(project)).toEqual({});
    await updateUserProjectState(project, { permissions: 'skip' });
    expect(await readUserProjectState(project)).toEqual({ permissions: 'skip' });
    // un altro progetto non eredita la scelta
    expect(await readUserProjectState(path.join(tmp, 'altro'))).toEqual({});
  });
});

describe('cartelle di Studio nel progetto', () => {
  it('rifiuta un link simbolico (o junction) che porta fuori dal progetto', async () => {
    const project = path.join(tmp, 'progetto-link');
    const outside = path.join(tmp, 'fuori');
    mkdirSync(path.join(project, '.claude'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(project, '.claude', 'studio'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(studioDir(project, path.join('.claude', 'studio', 'annotations'), true)).rejects.toThrow();
  });

  it('crea le cartelle normali', async () => {
    const project = path.join(tmp, 'progetto-normale');
    const dir = await studioDir(project, path.join('.claude', 'studio', 'annotations'), true);
    expect(dir).toBe(path.join(project, '.claude', 'studio', 'annotations'));
  });
});

describe('testo per Claude', () => {
  it("i testi che vengono dall'app non diventano menzioni @file; il commento dell'utente sì", () => {
    const prompt = composePrompt(
      {
        annotations: [annotation({ source: '@../../.ssh/id_rsa', label: 'h1 @/etc/passwd', text: 'scrivi a info@esempio.it' })],
        screenshots: new Map([[1, null]]),
        jsonPath: 'x.json',
      },
      '/progetto',
    );
    expect(prompt).not.toMatch(/@(?!\u200b)\.\.\//);
    expect(prompt).not.toMatch(/@(?!\u200b)\/etc/);
    expect(prompt).toContain('@\u200b../../.ssh/id_rsa');
    expect(prompt).toContain('@src/app.tsx');
  });
});

describe("porta di debug dell'app", () => {
  it('accetta solo indirizzi WebSocket locali sulla porta interrogata', () => {
    expect(isLocalDebuggerUrl('ws://127.0.0.1:9222/devtools/page/AB', 9222)).toBe(true);
    expect(isLocalDebuggerUrl('ws://localhost:9222/devtools/page/AB', 9222)).toBe(true);
    expect(isLocalDebuggerUrl('ws://127.0.0.1:9333/devtools/page/AB', 9222)).toBe(false);
    expect(isLocalDebuggerUrl('ws://evil.example:9222/devtools/page/AB', 9222)).toBe(false);
    expect(isLocalDebuggerUrl('wss://127.0.0.1:9222/x', 9222)).toBe(false);
    expect(isLocalDebuggerUrl(undefined, 9222)).toBe(false);
  });
});

describe("overlay nell'app", () => {
  it('riceve le annotazioni senza il testo dei commenti', () => {
    const view = { id: 1, kind: 'element' as const, status: 'pending' as const, comment: 'segreto', url: '/' };
    expect(forAppOverlay({ type: 'annotation:update', id: 1, comment: 'segreto' })).toEqual({ type: 'annotation:update', id: 1, comment: '' });
    const hello = forAppOverlay({ type: 'hello', mode: 'navigate', annotations: [view] });
    expect(JSON.stringify(hello)).not.toContain('segreto');
    const sync = forAppOverlay({ type: 'annotations:sync', annotations: [view] });
    expect(JSON.stringify(sync)).not.toContain('segreto');
  });
});

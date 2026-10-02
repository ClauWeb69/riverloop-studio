import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findUserStatusLine, hookSettings, mergeSettings } from '../../src/server/hooks.js';
import { parseStatus } from '../../src/server/index.js';
import { ClaudeSession, emptyStatus, screenStatusPatch } from '../../src/server/pty.js';
import { effortIndicator, inputBoxText, permissionMode, screenState } from '../../src/server/tui.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-claude-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Fondo dello schermo di Claude Code 2.1.287 (riquadro di input, avviso, status line, modalità). */
const screen = (footer: string, input = '') => [
  'risposta precedente',
  '─'.repeat(70),
  `❯\u00a0${input}`,
  '─'.repeat(70),
  '  ⚠ Transcript saving is off',
  '  riga della status line',
  `  ${footer}`,
];

describe('modalità dei permessi lette dallo schermo', () => {
  it('riconosce le modalità di Shift+Tab', () => {
    expect(permissionMode(screen('⏸ manual mode on · ? for shortcuts'))).toBe('default');
    expect(permissionMode(screen('⏵⏵ accept edits on (shift+tab to cycle)'))).toBe('acceptEdits');
    expect(permissionMode(screen('⏸ plan mode on (shift+tab to cycle)'))).toBe('plan');
    expect(permissionMode(screen('⏵⏵ auto mode on (shift+tab to cycle)'))).toBe('auto');
    expect(permissionMode(screen('⏵⏵ bypass permissions on (shift+tab to cycle)'))).toBe('bypassPermissions');
  });

  it('nel dubbio nessuna modalità: senza riquadro di input o con testi sconosciuti', () => {
    expect(permissionMode(screen('? for shortcuts'))).toBeNull();
    expect(permissionMode(['Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'])).toBeNull();
    // la stessa frase nella conversazione, sopra il riquadro, non conta
    expect(permissionMode(['plan mode on', ...screen('nulla di noto')])).toBeNull();
  });
});

/**
 * Fondo dello schermo con l'indicatore dell'effort sopra il riquadro, ricostruito a mano da quello
 * di Claude Code 2.1.287 (non è una registrazione: allineamento e larghezze come nel 2.1.286 registrato).
 */
const withIndicator = (indicator: string | null, opts: { above?: string[]; topRule?: string; input?: string; width?: number } = {}) => [
  ...(opts.above ?? ['● Fatto.', '']),
  ...(indicator === null ? [''] : [' '.repeat((opts.width ?? 110) - 2 - [...indicator].length) + indicator]),
  opts.topRule ?? '─'.repeat(opts.width ?? 110),
  `❯\u00a0${opts.input ?? ''}`,
  '─'.repeat(opts.width ?? 110),
  '  ⏸ manual mode on · ? for shortcuts · ← for agents',
];

describe("indicatore dell'effort sopra il riquadro di input", () => {
  it('legge livello e ultracode dalle righe di Claude Code 2.1.287', () => {
    expect(effortIndicator(withIndicator('◉ xhigh · /effort'))).toEqual({ level: 'xhigh', ultracode: false });
    expect(effortIndicator(withIndicator('○ low · /effort'))).toEqual({ level: 'low', ultracode: false });
    expect(effortIndicator(withIndicator('◐ medium · /effort'))).toEqual({ level: 'medium', ultracode: false });
    // con ultracode anche la linea sopra il riquadro ha un'etichetta (schermo vero di Claude Code 2.1.287)
    const ultra = withIndicator('◉ xhigh · ultracode · /effort', { topRule: `${'─'.repeat(97)} ultracode ─` });
    expect(effortIndicator(ultra)).toEqual({ level: 'xhigh', ultracode: true });
    // ...e il riquadro resta riconosciuto (invio automatico e barra continuano a funzionare)
    expect(screenState(ultra)).toBe('input');
    expect(permissionMode(ultra)).toBe('default');
    expect(inputBoxText(withIndicator('◉ xhigh · ultracode · /effort', { topRule: `${'─'.repeat(97)} ultracode ─`, input: 'ciao' }))).toBe('❯\u00a0ciao');
  });

  it("l'etichetta è ammessa solo sulla linea di sopra del riquadro", () => {
    const labelled = `${'─'.repeat(97)} ultracode ─`;
    // la linea di sotto è la penultima riga dello schermo di prova
    const bottomLabelled = withIndicator('◉ xhigh · /effort').map((l, i, all) => (i === all.length - 2 ? labelled : l));
    expect(inputBoxText(bottomLabelled)).toBeNull();
    expect(effortIndicator(bottomLabelled)).toBeNull();
    expect(screenState(bottomLabelled)).toBe('unknown');
  });

  it('legge lo schermo registrato di Claude Code 2.1.286', () => {
    const recorded = readFileSync(new URL('../fixtures/claude-screens/2.1.286-inviato.txt', import.meta.url), 'utf8').split(/\r?\n/);
    expect(effortIndicator(recorded)).toEqual({ level: 'medium', ultracode: false });
  });

  it('nel dubbio nulla: indicatore assente, riquadro assente, frasi simili nella conversazione', () => {
    expect(effortIndicator(withIndicator(null))).toBeNull();
    expect(effortIndicator(['Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'])).toBeNull();
    // la stessa riga nella conversazione, più in alto, non conta
    expect(effortIndicator(withIndicator(null, { above: ['                    ◉ high · /effort', '● Ok.'] }))).toBeNull();
    // né subito sopra il riquadro se non è allineata a destra (testo di una risposta), anche se rientrata
    expect(effortIndicator(withIndicator(null, { above: ['● Ecco:', '  ◉ high · /effort'] }).filter((l) => l !== ''))).toBeNull();
    expect(effortIndicator(withIndicator(null, { above: ['● Ecco:', '    ◉ high · /effort'] }).filter((l) => l !== ''))).toBeNull();
    expect(effortIndicator(withIndicator(null, { above: ['● Ecco:', `${' '.repeat(60)}◉ high · /effort`] }).filter((l) => l !== ''))).toBeNull();
    // livelli o testi sconosciuti
    expect(effortIndicator(withIndicator('◉ turbo · /effort'))).toBeNull();
    expect(effortIndicator(withIndicator('◉ high · /effort · altro'))).toBeNull();
  });
});

describe('effort e ultracode: status line e schermo insieme', () => {
  const ultra = withIndicator('◉ xhigh · ultracode · /effort', { topRule: `${'─'.repeat(97)} ultracode ─` });

  it("l'indicatore conta solo quando cambia: un effort più recente dalla status line resta", () => {
    let status = { ...emptyStatus(), effort: 'xhigh' };
    const first = screenStatusPatch(status, ultra, null);
    expect(first).toEqual({ patch: { ultracode: true, mode: 'default' }, lastIndicator: 'xhigh|true' });
    // la status line porta "low" (es. /effort low appena eseguito): lo schermo invariato non lo riporta a xhigh
    status = { ...status, ...first.patch, effort: 'low' };
    expect(screenStatusPatch(status, ultra, first.lastIndicator)).toEqual({ patch: {}, lastIndicator: 'xhigh|true' });
    // l'indicatore cambia: vale lui
    expect(screenStatusPatch(status, withIndicator('○ low · /effort'), first.lastIndicator)).toEqual({
      patch: { ultracode: false },
      lastIndicator: 'low|false',
    });
    // senza lettura dell'indicatore (nuovo processo che non l'ha ancora disegnato) nulla cambia
    expect(screenStatusPatch({ ...status, mode: 'default' }, ultra, null, false)).toEqual({ patch: {}, lastIndicator: null });
  });

  const session = () => new ClaudeSession({ command: { path: 'claude', viaCmd: false }, extraArgs: [], resumeFirst: false, cwd: tmp, permissions: 'ask' });
  // Accesso ai metodi privati: lo specchio dello schermo si riempie come con l'output di claude
  type Internals = { ptyOutput(data: string): void; broadcastOutput(data: string): void; resetScreenStatus(): void };
  const settle = () => new Promise((r) => setTimeout(r, 400));

  it('un effort mancante nella status line non cancella quello noto', () => {
    const s = session();
    s.setStatus({ effort: 'high', model: 'Opus' });
    s.setStatus({ effort: null, model: 'Sonnet' });
    expect(s.status).toMatchObject({ effort: 'high', model: 'Sonnet' });
  });

  it('dopo un riavvio ultracode resta sconosciuto finché il nuovo processo non disegna il suo indicatore', async () => {
    const s = session();
    const internals = s as unknown as Internals;
    // lo specchio è largo 100 colonne
    internals.ptyOutput(withIndicator('◉ xhigh · ultracode · /effort', { width: 90, topRule: `${'─'.repeat(77)} ultracode ─` }).join('\r\n'));
    await settle();
    expect(s.status).toMatchObject({ effort: 'xhigh', ultracode: true });

    // Riavvio: lo specchio ha ancora lo schermo del processo precedente, più il messaggio di riavvio
    internals.resetScreenStatus();
    expect(s.status.ultracode).toBeNull();
    internals.broadcastOutput('\r\n[riavvio]\r\n');
    internals.ptyOutput('\x1b[?25l');
    await settle();
    expect(s.status.ultracode).toBeNull();

    // Il nuovo processo disegna il suo indicatore (anche spezzato in più pezzi)
    const plain = withIndicator('◉ xhigh · /effort', { width: 90 }).join('\r\n');
    const cut = plain.indexOf('/eff') + 2;
    internals.ptyOutput(plain.slice(0, cut));
    internals.ptyOutput(plain.slice(cut));
    await settle();
    expect(s.status).toMatchObject({ effort: 'xhigh', ultracode: false });

    // Un effort più recente dalla status line non viene sovrascritto dallo schermo invariato
    s.setStatus({ effort: 'low' });
    internals.ptyOutput('\r\n');
    await settle();
    expect(s.status.effort).toBe('low');
  });

  /** Sessione con un finto processo: dopo l'Invio ridisegna lo schermo con o senza ultracode. */
  const withFakePty = (accept: boolean) => {
    const s = session();
    const internals = s as unknown as Internals & { pty: unknown };
    const draw = (ultra: boolean) =>
      internals.ptyOutput(
        '\x1b[2J\x1b[H' +
          (ultra
            ? withIndicator('◉ high · ultracode · /effort', { width: 90, topRule: `${'─'.repeat(77)} ultracode ─` })
            : withIndicator('◉ high · /effort', { width: 90 })
          ).join('\r\n'),
      );
    const written: string[] = [];
    internals.pty = {
      pid: 1,
      write(data: string) {
        written.push(data);
        if (data === '\r') draw(accept);
      },
    };
    s.state = 'running';
    draw(false);
    return { s, written };
  };

  it('ultracode dalla barra: ok solo quando lo schermo lo conferma', async () => {
    const { s, written } = withFakePty(true);
    await settle();
    expect(await s.setUltracode(true)).toBe('ok');
    expect(written.join('')).toBe('/effort ultracode on\r');
    expect(s.status.ultracode).toBe(true);
  });

  it('ultracode rifiutato da Claude Code (modello o piano senza ultracode): non confermato', async () => {
    const { s } = withFakePty(false);
    await settle();
    expect(await s.setUltracode(true)).toBe('ultracode-unconfirmed');
    expect(s.status.ultracode).toBe(false);
  }, 15000);
});

describe('dati della status line', () => {
  it('tiene solo i campi utili, con valori controllati', () => {
    const status = parseStatus({
      model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
      effort: { level: 'medium' },
      rate_limits: { five_hour: { used_percentage: 38.26, resets_at: 1790911200 }, seven_day: { used_percentage: 250, resets_at: 'domani' } },
      context_window: { used_percentage: null },
      cost: { total_cost_usd: 0.1234 },
    });
    expect(status).toEqual({
      model: 'Opus 5.5',
      modelId: 'claude-opus-5-5',
      effort: 'medium',
      fiveHour: { used: 38.3, resetsAt: 1790911200 },
      sevenDay: { used: 100, resetsAt: null },
      context: null,
      costUsd: 0.12,
    });
    // senza abbonamento (o prima della prima risposta) i limiti mancano
    expect(parseStatus({ model: { display_name: 'Sonnet' } })).toMatchObject({ model: 'Sonnet', fiveHour: null, sevenDay: null });
    expect(parseStatus(undefined)).toMatchObject({ model: null, effort: null });
    // testo con sequenze di controllo: ripulito
    expect(parseStatus({ model: { display_name: 'Opus\x1b[31m 5' } }).model).toBe('Opus 5');
  });
});

describe("status line dell'utente", () => {
  it('la trova con la precedenza di Claude Code e la conserva', () => {
    const project = path.join(tmp, 'progetto');
    const config = path.join(tmp, 'config');
    mkdirSync(path.join(project, '.claude'), { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'utente.sh', padding: 1 } }));
    const env = { CLAUDE_CONFIG_DIR: config };
    expect(findUserStatusLine(project, {}, env)).toEqual({ command: 'utente.sh', padding: 1 });
    writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'progetto.sh' } }));
    expect(findUserStatusLine(project, {}, env)?.command).toBe('progetto.sh');
    expect(findUserStatusLine(project, { statusLine: { type: 'command', command: 'flag.sh', refreshInterval: 5 } }, env)).toEqual({
      command: 'flag.sh',
      refreshInterval: 5,
    });

    // Nel file passato a Claude Code la status line è quella di Studio, con padding e intervallo dell'utente
    const merged = mergeSettings(
      { model: 'opus' },
      hookSettings('node "hook.js"', 'node "statusline.js"', { command: 'flag.sh', padding: 2, refreshInterval: 5 }),
    );
    expect(merged.statusLine).toEqual({ type: 'command', command: 'node "statusline.js"', padding: 2, refreshInterval: 5 });
    expect(merged.model).toBe('opus');
    expect(Object.keys(merged.hooks as object)).toEqual(['PostToolUse', 'Stop']);
  });
});

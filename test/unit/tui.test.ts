import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inputBoxText, pasteStillInInput, screenState } from '../../src/server/tui.js';

// Schermate vere di Claude Code 2.1.286 (110×40), registrate con una finta API Anthropic.
const screen = (name: string) => readFileSync(new URL(`../fixtures/claude-screens/${name}`, import.meta.url), 'utf8').split('\n');
const FIRST = 'Modifiche richieste sulla pagina / (viewport 960×826):';
// Claude Code mette uno spazio non separabile (U+00A0) dopo il cursore ❯
const box = (s: string[]) => inputBoxText(s)?.replace(/\u00a0/g, ' ') ?? null;

describe('schermo di Claude Code: invio automatico', () => {
  it('riconosce il testo incollato rimasto nel riquadro di input', () => {
    const s = screen('2.1.286-incollato.txt');
    expect(box(s)).toBe('❯ [Pasted text #1 +7 lines]');
    expect(pasteStillInInput(s, FIRST)).toBe(true);
  });

  it('riconosce anche il testo digitato per intero (senza bracketed paste)', () => {
    const s = screen('2.1.286-digitato-con-suggerimento.txt');
    expect(box(s)?.startsWith('❯ Modifiche richieste sulla pagina')).toBe(true);
    expect(pasteStillInInput(s, FIRST)).toBe(true);
    // con una prima riga che non c'entra non ripete Invio
    expect(pasteStillInInput(s, "Tutt'altro messaggio di prova")).toBe(false);
  });

  it("dopo l'invio, anche mentre Claude lavora, non ripete Invio", () => {
    for (const name of ['2.1.286-inviato.txt', '2.1.286-in-elaborazione.txt']) {
      const s = screen(name);
      expect(box(s)).toBe('❯');
      // il messaggio inviato resta visibile più in alto, fuori dal riquadro di input
      expect(s.some((l) => l.replace(/\u00a0/g, ' ').startsWith('❯ Modifiche richieste'))).toBe(true);
      expect(pasteStillInInput(s, FIRST)).toBe(false);
    }
  });

  it('con una richiesta di permesso aperta non preme mai Invio', () => {
    const s = screen('2.1.286-richiesta-permesso.txt');
    expect(box(s)).toBeNull();
    expect(pasteStillInInput(s, FIRST)).toBe(false);
    // nemmeno se la richiesta contiene la prima riga del messaggio o un segnaposto
    const tricky = s.map((l) => (l.includes('echo approvato') ? ` echo "${FIRST} [Pasted text #1 +7 lines]"` : l));
    expect(pasteStillInInput(tricky, FIRST)).toBe(false);
    // né se la finestra di conferma è disegnata dentro due linee continue
    const boxed = ['─'.repeat(40), '❯ [Pasted text #1 +7 lines]', '─'.repeat(40), ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'];
    expect(pasteStillInInput(boxed, FIRST)).toBe(false);
    // ...nemmeno con le linee che finiscono con un'etichetta (come quella di ultracode)
    const label = `${'─'.repeat(30)} ultracode ─`;
    const labelled = [label, '❯ [Pasted text #1 +7 lines]', label, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'];
    expect(pasteStillInInput(labelled, FIRST)).toBe(false);
    expect(screenState(labelled)).toBe('awaiting-answer');
    const permission = s.map((l) => (/^─{10,}$/.test(l.trim()) ? `${l.trim().slice(0, -12)} bash tool ─` : l));
    expect(permission.some((l) => l.endsWith('bash tool ─'))).toBe(true);
    expect(screenState(permission)).toBe('awaiting-answer');
    expect(pasteStillInInput(permission, FIRST)).toBe(false);
  });

  it('riconosce il riquadro con gli angoli delle versioni precedenti', () => {
    const old = ['╭────────────────────────╮', '│ > [Pasted text #2 +12 lines]  │', '╰────────────────────────╯', '  ? for shortcuts'];
    expect(pasteStillInInput(old, FIRST)).toBe(true);
    const empty = ['╭────────────────────────╮', '│ >                       │', '╰────────────────────────╯'];
    expect(pasteStillInInput(empty, FIRST)).toBe(false);
  });

  it('nel dubbio risponde no', () => {
    expect(pasteStillInInput([], FIRST)).toBe(false);
    expect(pasteStillInInput(['niente riquadro', FIRST], FIRST)).toBe(false);
    // menu di scelta disegnato al posto del riquadro
    expect(pasteStillInInput(['─'.repeat(30), '❯ 1. Yes', '  2. No', '─'.repeat(30)], FIRST)).toBe(false);
    // ...anche con l'etichetta sulla linea di sotto
    const menu = ['─'.repeat(30), '❯ 1. Yes', '  2. No', `${'─'.repeat(30)} ultracode ─`];
    expect(pasteStillInInput(menu, FIRST)).toBe(false);
    expect(screenState(menu)).toBe('awaiting-answer');
    // un'etichetta sulla linea di sopra è quella di ultracode: il riquadro resta riconosciuto
    expect(pasteStillInInput([`${'─'.repeat(30)} ultracode ─`, '❯ [Pasted text #1 +3 lines]', '─'.repeat(30)], FIRST)).toBe(true);
    // ...sulla linea di sotto no (nel dubbio, nessun riquadro)
    expect(pasteStillInInput(['─'.repeat(30), '❯ [Pasted text #1 +3 lines]', `${'─'.repeat(30)} ultracode ─`], FIRST)).toBe(false);
    // etichette che non sono brevi parole minuscole: la linea non è una linea del riquadro
    expect(pasteStillInInput(['─'.repeat(30), '❯ [Pasted text #1 +3 lines]', `${'─'.repeat(30)} Ultracode ─`], FIRST)).toBe(false);
    expect(pasteStillInInput(['─'.repeat(30), '❯ [Pasted text #1 +3 lines]', `${'─'.repeat(30)} ${'x'.repeat(30)} ─`], FIRST)).toBe(false);
    // troppe righe sotto il riquadro: non è l'ultima cosa sullo schermo
    const tail = ['─'.repeat(30), '❯ [Pasted text #1 +3 lines]', '─'.repeat(30), 'a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(pasteStillInInput(tail, FIRST)).toBe(false);
  });
});

describe('schermo di Claude Code: stato', () => {
  it('distingue riquadro di input, richiesta in attesa e schermate sconosciute', () => {
    expect(screenState(screen('2.1.286-incollato.txt'))).toBe('input');
    expect(screenState(screen('2.1.286-in-elaborazione.txt'))).toBe('input');
    expect(screenState(screen('2.1.286-richiesta-permesso.txt'))).toBe('awaiting-answer');
    // la domanda di fiducia sulla cartella, all'avvio
    const trust = ['Do you trust the files in this folder?', '', ' ❯ 1. Yes, proceed', '   2. No, exit', '', ' Enter to confirm · Esc to cancel'];
    expect(screenState(trust)).toBe('awaiting-answer');
    expect(screenState(['qualcosa di nuovo', 'che non riconosciamo'])).toBe('unknown');
    // una domanda di Claude nel testo della conversazione non blocca l'incolla
    const chat = ['● Do you want to proceed with the migration?', '', '─'.repeat(30), '❯', '─'.repeat(30), '  ? for shortcuts'];
    expect(screenState(chat)).toBe('input');
  });
});

describe('schermo di Claude Code: testi già risolti più in alto', () => {
  it('una richiesta di permesso già chiusa, rimasta più in alto, non blocca il nuovo Invio', () => {
    const s = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      ' Esc to cancel · Tab to amend',
      '─'.repeat(40),
      '❯ [Pasted text #2 +4 lines]',
      '─'.repeat(40),
      '  ⏸ manual mode on · ? for shortcuts',
    ];
    expect(pasteStillInInput(s, FIRST)).toBe(true);
    expect(screenState(s)).toBe('input');
  });
});

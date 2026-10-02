import { afterEach, describe, expect, it } from 'vitest';
import { composePrompt, normalizeAnnotation } from '../../src/server/annotations.js';
import { getLocale, localeChosen, setLocale, systemLocale, t, tIn } from '../../src/server/i18n.js';
import { en } from '../../src/server/locales/en.js';
import { it as itDict } from '../../src/server/locales/it.js';
import { createTranslator, normalizeLocale } from '../../src/shared/i18n.js';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('lingue', () => {
  afterEach(() => {
    // vitest.config.ts imposta RIVERLOOP_STUDIO_LANG=it: gli altri test si aspettano l'italiano
    setLocale('it', true);
  });

  it('riconosce la lingua da tag BCP 47 e variabili POSIX', () => {
    expect(normalizeLocale('it-IT')).toBe('it');
    expect(normalizeLocale('en_US.UTF-8')).toBe('en');
    expect(normalizeLocale('IT')).toBe('it');
    expect(normalizeLocale('fr')).toBeNull();
    expect(normalizeLocale('')).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
  });

  it('legge la lingua del sistema saltando C e POSIX', () => {
    expect(systemLocale({ LANG: 'C', LANGUAGE: 'it:en' })).toBe('it');
    expect(systemLocale({ LC_ALL: 'POSIX', LC_MESSAGES: 'it_IT.UTF-8', LANG: 'en_US.UTF-8' })).toBe('it');
    expect(systemLocale({ LC_ALL: 'C', LANG: 'en_GB.UTF-8' })).toBe('en');
    // Nessuna variabile utile: decide Intl, che può dare qualunque lingua supportata o nessuna
    expect(['en', 'it', null]).toContain(systemLocale({ LANG: 'C', LANGUAGE: 'fr' }));
  });

  it('nei test parte in italiano, come scelta esplicita', () => {
    expect(getLocale()).toBe('it');
    expect(localeChosen()).toBe(true);
  });

  it('i dizionari del server hanno le stesse chiavi e gli stessi parametri', () => {
    const itKeys = Object.keys(itDict).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(itKeys);
    for (const key of itKeys) {
      const k = key as keyof typeof itDict;
      expect({ key, params: placeholders(en[k]) }).toEqual({ key, params: placeholders(itDict[k]) });
      expect(en[k].trim(), key).not.toBe('');
    }
  });

  it('sostituisce i parametri e sceglie la forma singolare con count 1', () => {
    const tit = tIn('it');
    expect(tit('cli.webIgnored', { count: 1, options: '--app-cmd' })).toBe('--app-cmd: vale solo con --mode window o --mode electron.');
    expect(tit('cli.webIgnored', { count: 2, options: '--app-cmd, --window-title' })).toBe(
      '--app-cmd, --window-title: valgono solo con --mode window o --mode electron.',
    );
    const ten = tIn('en');
    expect(ten('prompt.context', { count: 1, ids: '3', path: 'a.png' })).toBe('Whole window with annotation 3: @a.png');
    expect(ten('prompt.context', { count: 2, ids: '3, 4', path: 'a.png' })).toBe('Whole window with annotations 3, 4: @a.png');
    // Senza parametri il testo resta com'è (qui {port} è testo per l'utente)
    expect(t('cli.electron.timeoutHint')).toContain('--remote-debugging-port={port}');
    // Un parametro mancante lascia il segnaposto; un valore con "$" o graffe non viene interpretato
    expect(tit('api.notRunning', {})).toBe('{who} non è in esecuzione: riavvialo dalla console e riprova.');
    expect(tit('api.notRunning', { who: '$& {who}' })).toBe('$& {who} non è in esecuzione: riavvialo dalla console e riprova.');
  });

  it("ricade sull'inglese e poi sulla chiave", () => {
    // Dizionario italiano incompleto apposta
    const dicts = { en: { a: 'A {x}', b: 'B' }, it: { a: 'a {x}' } };
    const tr = createTranslator<{ a: string; b: string }>(dicts as never, () => 'it');
    expect(tr('a', { x: 1 })).toBe('a 1');
    expect(tr('b')).toBe('B');
    expect(tr('c' as 'a')).toBe('c');
  });

  it('compone la richiesta per Claude Code in inglese', () => {
    setLocale('en');
    const base = {
      url: '/pricing',
      title: 'Pricing',
      viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 850, dpr: 1 },
      anchor: {},
    };
    const prompt = composePrompt(
      {
        annotations: [
          normalizeAnnotation({
            ...base,
            id: 1,
            kind: 'element',
            comment: 'make it smaller',
            selector: 'main > h1',
            text: 'Welcome',
            rect: { x: 10, y: 10, width: 200, height: 40 },
            viewportRect: { x: 10, y: 10, width: 200, height: 40 },
            components: ['Hero', 'HomePage'],
            source: 'src/Hero.tsx:12:5',
          }),
          normalizeAnnotation({
            ...base,
            id: 2,
            kind: 'area',
            comment: '',
            rect: { x: 1000, y: 1500, width: 320, height: 180 },
            viewportRect: { x: 1050, y: 650, width: 320, height: 180 },
            container: { label: 'section#prices', selector: '#prices' },
            heading: 'Our prices',
            contains: [],
            screenshotError: 'capture failed',
          }),
        ],
        screenshots: new Map<number, string | null>([
          [1, '.claude/studio/annotations/x-1.png'],
          [2, null],
        ]),
        jsonPath: '.claude/studio/annotations/x.json',
      },
      process.cwd(),
    );
    expect(prompt).toBe(
      [
        'Requested changes on the page /pricing (viewport 1440×900):',
        '',
        '1. Element `main > h1` — text "Welcome"',
        '   Request: make it smaller',
        '   React component: Hero (inside HomePage)',
        '   Source: src/Hero.tsx:12:5',
        '   Screenshot: @.claude/studio/annotations/x-1.png',
        '',
        '2. Area of 320×180 px (on screen: bottom right)',
        '   Position in the page: x 1000–1320, y 1500–1680 px (on screen x 1050–1370, y 650–830, with the page scrolled by 850 px vertically)',
        '   Located: inside `#prices`, under the heading "Our prices"',
        '   Contains: no whole element (the area covers parts of larger elements)',
        '   Request: (no comment)',
        '   Screenshot: not available (capture failed)',
        '',
        'Full details (HTML, styles, position): @.claude/studio/annotations/x.json',
        'In the screenshots each annotation is highlighted with its number.',
      ].join('\n'),
    );
    // L'ultima riga resta testo semplice, mai un percorso @
    expect(prompt.split('\n').at(-1)).not.toMatch(/@/);
  });

  it('cambiando lingua cambia anche la richiesta composta', () => {
    const input = {
      annotations: [
        normalizeAnnotation({
          id: 1,
          kind: 'element',
          comment: 'x',
          url: '/',
          viewport: { width: 800, height: 600 },
          rect: {},
          viewportRect: {},
          anchor: {},
          selector: 'h1',
        }),
      ],
      screenshots: new Map<number, string | null>([[1, null]]),
      jsonPath: 'a.json',
    };
    setLocale('it');
    expect(composePrompt(input, process.cwd()).split('\n')[0]).toBe('Modifiche richieste sulla pagina / (viewport 800×600):');
    setLocale('en');
    expect(composePrompt(input, process.cwd()).split('\n').at(-1)).toBe('Screenshots are not available: use the JSON file for the details.');
  });
});

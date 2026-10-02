import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupAnnotations, composePrompt, describePosition, normalizeAnnotation, parseRequest, saveAnnotations } from '../../src/server/annotations.js';
import { injectIntoHtml, InjectTransform, rewriteLocation, rewriteSetCookie, shouldInject } from '../../src/server/proxy.js';
import { parseCookies, Security, stripStudioCookies } from '../../src/server/security.js';
import { commandLine, quoteForCmd, resolveExecutable, sanitizeForTerminal, sanitizeInline, splitArgs, stripAnsi } from '../../src/server/util.js';
import type { AnnotationData } from '../../src/shared/protocol.js';

const req = (headers: Record<string, string>, method = 'GET', url = '/') => ({ headers, method, url }) as unknown as IncomingMessage;
const res = (status: number, headers: Record<string, string>) => ({ statusCode: status, headers }) as unknown as IncomingMessage;

// PNG 1x1 valido
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

function annotation(partial: Partial<AnnotationData> = {}): AnnotationData {
  return {
    id: 1,
    kind: 'element',
    comment: 'rendi il titolo più piccolo e allinealo a sinistra',
    url: '/dashboard',
    title: 'Dashboard',
    viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0, dpr: 1 },
    selector: 'main > section.hero > h1',
    label: 'h1',
    html: '<h1>Benvenuti in AgendaCura</h1>',
    text: 'Benvenuti in AgendaCura',
    styles: { 'font-size': '48px' },
    rect: { x: 100, y: 120, width: 600, height: 60 },
    viewportRect: { x: 100, y: 120, width: 600, height: 60 },
    anchor: { selector: 'main > section.hero > h1', offsetX: 0, offsetY: 0 },
    screenshot: PNG,
    ...partial,
  };
}

describe('util', () => {
  it('splitArgs gestisce virgolette e spazi', () => {
    expect(splitArgs('--model "fake model" -p \'a b\'  --verbose')).toEqual(['--model', 'fake model', '-p', 'a b', '--verbose']);
    expect(splitArgs('')).toEqual([]);
    expect(splitArgs('--x ""')).toEqual(['--x', '']);
  });

  it('sanitizeForTerminal rimuove escape e caratteri di controllo', () => {
    const evil = 'ciao\x1b[201~\x1b]0;titolo\x07\r\nriga 2\tfine\x00\x9b31m';
    const clean = sanitizeForTerminal(evil);
    expect(clean).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(clean).toContain('ciao');
    expect(clean).toContain('\nriga 2  fine');
    expect(stripAnsi('\x1b[31mrosso\x1b[0m')).toBe('rosso');
    expect(sanitizeInline('a\n  b\tc', 10)).toBe('a b c');
  });

  it('gli script .js/.mjs (es. --claude-bin cli.js) si avviano con node', () => {
    const file = path.join(os.tmpdir(), `rls-fake-${process.pid}.mjs`);
    writeFileSync(file, 'console.log(1)');
    try {
      const cmd = resolveExecutable(file);
      expect(cmd?.nodeScript).toBe(file);
      expect(commandLine(cmd!, ['--version'])).toEqual({ file: process.execPath, args: [file, '--version'] });
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('quoteForCmd protegge spazi e virgolette', () => {
    expect(quoteForCmd('semplice')).toBe('semplice');
    expect(quoteForCmd('con spazio')).toBe('"con spazio"');
    expect(quoteForCmd('a"b')).toBe('"a""b"');
  });
});

describe('sicurezza', () => {
  const sec = new Security({ token: 'a'.repeat(64), studioPort: 4700, proxyPort: 4701 });

  it("API: accetta solo il token corretto nell'header X-Studio-Token", () => {
    expect(sec.isAuthorized(req({ 'x-studio-token': 'a'.repeat(64) }))).toBe(true);
    expect(sec.isAuthorized(req({ 'x-studio-token': 'b'.repeat(64) }))).toBe(false);
    expect(sec.isAuthorized(req({ cookie: `rls_studio_4700=${'a'.repeat(64)}` }))).toBe(false);
    expect(sec.isAuthorized(req({}))).toBe(false);
    expect(sec.tokenMatches('a'.repeat(63))).toBe(false);
  });

  it('WebSocket: il token arriva come sottoprotocollo', () => {
    expect(sec.wsAuthorized(req({ 'sec-websocket-protocol': `riverloop-studio, rls-token.${'a'.repeat(64)}` }))).toBe(true);
    expect(sec.wsAuthorized(req({ 'sec-websocket-protocol': 'riverloop-studio' }))).toBe(false);
    expect(sec.wsAuthorized(req({ 'sec-websocket-protocol': `rls-token.${'c'.repeat(64)}` }))).toBe(false);
  });

  it('proxy: cookie separato, valido se uno dei valori corrisponde', () => {
    const good = `rls_proxy_4700=${sec.proxyToken}`;
    expect(sec.proxyToken).not.toBe(sec.token);
    expect(sec.proxyAuthorized(req({ cookie: good }))).toBe(true);
    // un cookie piantato con lo stesso nome non blocca l'accesso
    expect(sec.proxyAuthorized(req({ cookie: `rls_proxy_4700=junk; ${good}` }))).toBe(true);
    expect(sec.proxyAuthorized(req({ cookie: `rls_proxy_4700=${sec.token}` }))).toBe(false);
    expect(sec.proxyCookie()).toMatch(/^rls_proxy_4700=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
    // il cookie del proxy non apre né le API né la console
    expect(sec.isAuthorized(req({ cookie: good }))).toBe(false);
    expect(sec.wsAuthorized(req({ cookie: good }))).toBe(false);
  });

  it('controlla Host e Origin', () => {
    expect(sec.hostAllowed(req({ host: '127.0.0.1:4700' }), 4700)).toBe(true);
    expect(sec.hostAllowed(req({ host: 'localhost:4700' }), 4700)).toBe(true);
    expect(sec.hostAllowed(req({ host: 'evil.example:4700' }), 4700)).toBe(false);
    expect(sec.hostAllowed(req({ host: '127.0.0.1:4701' }), 4700)).toBe(false);
    expect(sec.originIn(req({ origin: 'http://127.0.0.1:4700' }), sec.studioOrigins())).toBe(true);
    expect(sec.originIn(req({ origin: 'http://127.0.0.1:4701' }), sec.studioOrigins())).toBe(false);
    expect(sec.originIn(req({}), sec.studioOrigins())).toBe(false);
  });

  it("i cookie di Studio non vengono inoltrati all'app", () => {
    const r = req({ cookie: 'session=abc; rls_proxy_4700=zzz; theme=dark; rls_studio_4800=yyy' });
    stripStudioCookies(r);
    expect(r.headers.cookie).toBe('session=abc; theme=dark');
    const only = req({ cookie: 'rls_proxy_4700=zzz' });
    stripStudioCookies(only);
    expect(only.headers.cookie).toBeUndefined();
    expect(parseCookies('a=1; b = 2 ;c').get('b')).toBe('2');
  });
});

describe('proxy', () => {
  it('riscrive i Location verso il proxy', () => {
    expect(rewriteLocation('http://localhost:3000/login?x=1#h', 3000, '127.0.0.1:4701')).toBe('http://127.0.0.1:4701/login?x=1#h');
    expect(rewriteLocation('http://127.0.0.1:3000/', 3000, 'localhost:4701')).toBe('http://localhost:4701/');
    expect(rewriteLocation('/relativo', 3000, '127.0.0.1:4701')).toBe('/relativo');
    expect(rewriteLocation('https://accounts.example.com/o', 3000, '127.0.0.1:4701')).toBe('https://accounts.example.com/o');
    expect(rewriteLocation('http://localhost:4000/', 3000, '127.0.0.1:4701')).toBe('http://localhost:4000/');
  });

  it('riscrive Domain e Secure dei cookie', () => {
    expect(rewriteSetCookie('sid=1; Domain=localhost; Path=/; Secure; HttpOnly; SameSite=None')).toBe('sid=1; Path=/; HttpOnly; SameSite=Lax');
    expect(rewriteSetCookie('a=b; Path=/; SameSite=Strict')).toBe('a=b; Path=/; SameSite=Strict');
    expect(rewriteSetCookie('__Host-x=1; Path=/; Secure; SameSite=None')).toBe('__Host-x=1; Path=/; Secure; SameSite=None');
  });

  it("inietta lo script prima dell'ultimo </body>", () => {
    const html = '<html><body><script>"</body>"</script><p>x</p></BODY></html>';
    const out = injectIntoHtml(html, '<s/>');
    expect(out).toBe('<html><body><script>"</body>"</script><p>x</p><s/></BODY></html>');
    expect(injectIntoHtml('<p>senza body</p>', '<s/>')).toBe('<p>senza body</p><s/>');
  });

  it('inietta in streaming anche se </body> è spezzato tra due pezzi', async () => {
    const t = new InjectTransform('<s/>');
    const src = new PassThrough();
    const chunks: Buffer[] = [];
    src.pipe(t).on('data', (d: Buffer) => chunks.push(d));
    const done = new Promise((r) => t.on('end', r));
    const text = Buffer.from('<body>città è bella</bo', 'utf8');
    // spezza anche un carattere UTF-8 a metà
    src.write(text.subarray(0, 10));
    src.write(text.subarray(10));
    src.write(Buffer.from('dy></html>', 'utf8'));
    src.end();
    await done;
    expect(Buffer.concat(chunks).toString('utf8')).toBe('<body>città è bella<s/></body></html>');
  });

  it("non trattiene i byte che non possono essere l'inizio di </body>", async () => {
    const t = new InjectTransform('<s/>');
    const chunks: string[] = [];
    t.on('data', (d: Buffer) => chunks.push(d.toString()));
    t.write(Buffer.from('<script>$RC("B:0","S:0")</script>'));
    await new Promise((r) => setImmediate(r));
    expect(chunks.join('')).toBe('<script>$RC("B:0","S:0")</script>');
    t.write(Buffer.from('<p>a</b'));
    await new Promise((r) => setImmediate(r));
    expect(chunks.join('')).toBe('<script>$RC("B:0","S:0")</script><p>a');
    t.end(Buffer.from('ody></html>'));
    await new Promise((r) => t.on('end', r));
    expect(chunks.join('')).toBe('<script>$RC("B:0","S:0")</script><p>a<s/></body></html>');
  });

  it('aggiunge lo script in fondo se </body> non arriva', async () => {
    const t = new InjectTransform('<s/>');
    const chunks: Buffer[] = [];
    t.on('data', (d: Buffer) => chunks.push(d));
    const done = new Promise((r) => t.on('end', r));
    t.end(Buffer.from('<p>frammento</p>'));
    await done;
    expect(Buffer.concat(chunks).toString()).toBe('<p>frammento</p><s/>');
  });

  it('decide quando iniettare', () => {
    const html = { 'content-type': 'text/html; charset=utf-8' };
    expect(shouldInject(req({ 'sec-fetch-dest': 'iframe' }), res(200, html))).toBe(true);
    expect(shouldInject(req({}), res(404, html))).toBe(true);
    expect(shouldInject(req({ 'sec-fetch-dest': 'empty' }), res(200, html))).toBe(false);
    expect(shouldInject(req({ rsc: '1' }), res(200, html))).toBe(false);
    expect(shouldInject(req({}, 'POST'), res(200, html))).toBe(false);
    expect(shouldInject(req({}), res(304, html))).toBe(false);
    expect(shouldInject(req({}), res(200, { 'content-type': 'application/json' }))).toBe(false);
  });
});

describe('annotazioni', () => {
  it('descrive la posizione nella viewport', () => {
    const vp = { width: 1200, height: 900, scrollX: 0, scrollY: 0, dpr: 1 };
    expect(describePosition({ x: 900, y: 700, width: 200, height: 100 }, vp)).toBe('in basso a destra');
    expect(describePosition({ x: 10, y: 10, width: 100, height: 50 }, vp)).toBe('in alto a sinistra');
    expect(describePosition({ x: 500, y: 400, width: 200, height: 100 }, vp)).toBe('al centro');
  });

  it('valida i dati in arrivo dal browser', () => {
    expect(() => normalizeAnnotation({ ...annotation(), kind: 'boh' })).toThrow();
    expect(() => normalizeAnnotation({ ...annotation(), id: 0 })).toThrow();
    const n = normalizeAnnotation({ ...annotation(), comment: 'x'.repeat(10000), extra: 'ignorato' });
    expect(n.comment.length).toBe(4000);
    expect((n as unknown as Record<string, unknown>).extra).toBeUndefined();
    expect(() => parseRequest({ annotations: [] })).toThrow();
    expect(() => parseRequest({ annotations: Array.from({ length: 51 }, (_, i) => annotation({ id: i + 1 })) })).toThrow();
    expect(parseRequest({ autoSend: 'si', annotations: [annotation()] }).autoSend).toBe(false);
  });

  it('compone il prompt come da specifica', () => {
    const shots = new Map<number, string | null>([
      [1, '.claude/studio/annotations/20261001-1.png'],
      [2, '.claude/studio/annotations/20261001-2.png'],
    ]);
    const prompt = composePrompt(
      {
        annotations: [
          annotation({ components: ['Hero', 'HomePage'] }),
          annotation({
            id: 2,
            kind: 'area',
            comment: "il pulsante deve essere verde\ncome quello dell'header",
            rect: { x: 1000, y: 1500, width: 320, height: 180 },
            viewportRect: { x: 1050, y: 650, width: 320, height: 180 },
            viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 850, dpr: 1 },
            contains: [
              { label: 'button.cta', selector: 'button.cta', text: 'Prenota ora' },
              { label: 'p.note', selector: 'p.note' },
            ],
            container: { label: 'section#prezzi', selector: '#prezzi', text: 'Piano base 19 €' },
            heading: 'I nostri prezzi',
          }),
        ],
        screenshots: shots,
        jsonPath: '.claude/studio/annotations/20261001.json',
      },
      '/progetto',
    );
    expect(prompt).toBe(
      [
        'Modifiche richieste sulla pagina /dashboard (viewport 1440×900):',
        '',
        '1. Elemento `main > section.hero > h1` — testo "Benvenuti in AgendaCura"',
        '   Richiesta: rendi il titolo più piccolo e allinealo a sinistra',
        '   Componente React: Hero (dentro HomePage)',
        '   Screenshot: @.claude/studio/annotations/20261001-1.png',
        '',
        '2. Zona di 320×180 px (sullo schermo: in basso a destra)',
        '   Posizione nella pagina: x 1000–1320, y 1500–1680 px (sullo schermo x 1050–1370, y 650–830, con la pagina scorsa di 850 px in verticale)',
        '   Si trova: dentro `#prezzi`, sotto il titolo "I nostri prezzi"',
        '   Contiene: `button.cta` "Prenota ora", `p.note`',
        '   Richiesta: il pulsante deve essere verde',
        "   come quello dell'header",
        '   Screenshot: @.claude/studio/annotations/20261001-2.png',
        '',
        'Dettagli completi (HTML, stili, posizione): @.claude/studio/annotations/20261001.json',
        'Negli screenshot ogni annotazione è evidenziata con il suo numero.',
      ].join('\n'),
    );
  });

  it('dice sempre dove si trova una zona, anche senza elementi interi dentro', () => {
    const prompt = composePrompt(
      {
        annotations: [
          annotation({
            kind: 'area',
            rect: { x: 40, y: 300, width: 200, height: 100 },
            viewportRect: { x: 40, y: 300, width: 200, height: 100 },
            contains: [],
            container: { label: 'div.card', selector: 'main > div.card:nth-of-type(2)', text: 'Piano Pro — 49 € al mese' },
            heading: null,
          }),
          annotation({
            id: 2,
            kind: 'drawing',
            rect: { x: 700, y: 820, width: 400, height: 20 },
            viewportRect: { x: 700, y: 820, width: 400, height: 20 },
            contains: [{ label: 'p', selector: 'main > p', text: 'Sottolinea questa frase' }],
            container: null,
            heading: 'Benvenuti',
          }),
        ],
        screenshots: new Map([
          [1, null],
          [2, null],
        ]),
        jsonPath: 'x.json',
      },
      '/progetto',
    );
    expect(prompt).toContain('1. Zona di 200×100 px (sullo schermo: a sinistra, a metà altezza)');
    expect(prompt).toContain("   Posizione nella pagina: x 40–240, y 300–400 px (dall'angolo in alto a sinistra)");
    expect(prompt).toContain('   Si trova: dentro `main > div.card:nth-of-type(2)` con il testo "Piano Pro — 49 € al mese"');
    expect(prompt).toContain('   Contiene: nessun elemento intero (la zona copre parti di elementi più grandi)');
    expect(prompt).toContain('2. Disegno su una zona di 400×20 px (sullo schermo: in basso al centro)');
    expect(prompt).toContain('   Si trova: sotto il titolo "Benvenuti"');
    expect(prompt).toContain('   Passa sopra: `p` "Sottolinea questa frase"');
    // Mai un percorso @... in fondo: Claude Code aprirebbe i suggerimenti dei file
    expect(prompt.split('\n').at(-1)).toBe('Gli screenshot non sono disponibili: per i dettagli usa il file JSON.');
  });

  it('accetta contenitore e titolo solo per zone e disegni, ripuliti', () => {
    const area = normalizeAnnotation({
      ...annotation({ kind: 'area' }),
      container: { label: 'section\x1b[31m', selector: '#x', text: 'a'.repeat(500) },
      heading: 'Titolo\nsu due righe',
    });
    expect(area.container?.text?.length).toBe(120);
    expect(area.heading).toBe('Titolo\nsu due righe');
    const prompt = composePrompt({ annotations: [area], screenshots: new Map([[1, null]]), jsonPath: 'x.json' }, '/p');
    expect(prompt).toContain('sotto il titolo "Titolo su due righe"');
    expect(prompt).not.toContain('\x1b');
    const el = normalizeAnnotation({ ...annotation(), container: { label: 'div', selector: 'div' }, heading: 'x' });
    expect(el.container).toBeUndefined();
    expect(el.heading).toBeUndefined();
  });

  it('raggruppa per pagina e segnala gli screenshot mancanti', () => {
    const prompt = composePrompt(
      {
        annotations: [annotation(), annotation({ id: 2, url: '/impostazioni', screenshotError: 'contenuto protetto' })],
        screenshots: new Map([
          [1, 'a.png'],
          [2, null],
        ]),
        jsonPath: 'x.json',
      },
      '/progetto',
    );
    expect(prompt).toContain('Modifiche richieste su più pagine.');
    expect(prompt).toContain('Sulla pagina /impostazioni (viewport 1440×900):');
    expect(prompt).toContain('Screenshot: non disponibile (contenuto protetto)');
  });

  it('rende relativo il percorso sorgente al progetto', () => {
    const prompt = composePrompt(
      { annotations: [annotation({ source: '/progetto/src/app/page.tsx:42' })], screenshots: new Map([[1, null]]), jsonPath: 'x.json' },
      '/progetto',
    );
    expect(prompt).toContain('   Sorgente: src/app/page.tsx:42');
  });

  const dir = mkdtempSync(path.join(os.tmpdir(), 'rls-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('salva screenshot e JSON solo dentro .claude/studio', async () => {
    const saved = await saveAnnotations(dir, {
      autoSend: false,
      annotations: [annotation(), annotation({ id: 2, screenshot: 'data:image/png;base64,bm9uIHVuIHBuZw==' })],
    });
    const files = readdirSync(path.join(dir, '.claude', 'studio', 'annotations'));
    expect(files.filter((f) => f.endsWith('.png'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    const json = JSON.parse(readFileSync(path.join(dir, saved.jsonPath), 'utf8'));
    expect(json.annotations[0].screenshot).toMatch(/^\.claude\/studio\/annotations\/\d{8}-\d{6}-1\.png$/);
    expect(json.annotations[1].screenshot).toBeNull();
    expect(json.annotations[1].screenshotError).toBe('immagine non valida');
    expect(JSON.stringify(json)).not.toContain('base64');
    expect(saved.prompt).toContain('Screenshot: non disponibile (immagine non valida)');
  });

  it('pulisce i file più vecchi di 7 giorni', async () => {
    const annDir = path.join(dir, '.claude', 'studio', 'annotations');
    const old = path.join(annDir, '20200101-000000.json');
    writeFileSync(old, '{}');
    const past = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    utimesSync(old, past, past);
    const removed = await cleanupAnnotations(dir, 7);
    expect(removed).toBe(1);
    expect(readdirSync(annDir)).not.toContain('20200101-000000.json');
  });
});

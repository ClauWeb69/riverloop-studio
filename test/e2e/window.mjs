#!/usr/bin/env node
// Test end-to-end della modalità window su una finestra nativa vera.
// Avvia riverloop-studio --mode window con il finto claude, apre la pagina Studio in Chromium
// e verifica: finestra trovata e mostrata dal vivo, strumenti sull'immagine (anche Elemento,
// con gli elementi dell'interfaccia nativa), fermo immagine, messaggio e file per Claude,
// finestra ridotta a icona, riavvii, aggancio a un'app già aperta, condivisione dal browser.
//
// Uso: node test/e2e/window.mjs [--chromium <percorso>] [--shots <cartella>] [--headed]
// L'app di prova è una finestra Windows Forms (test/fixtures/native-app.ps1): il test gira su Windows.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCapturer } from '../../dist/src/server/wincapture.js';
import { assert, canvasBox, comment, isPng, isWindows, openStudio, pending, ROOT, shot, sleep, startStudio, suite, waitFor } from './desktop-lib.mjs';

if (!isWindows) {
  console.log("Il test della modalità window usa un'app Windows Forms: su questo sistema viene saltato.");
  process.exit(0);
}

const FIXTURE = path.join(ROOT, 'test/fixtures/native-app.ps1');
const APP_CMD = `powershell -NoProfile -ExecutionPolicy Bypass -File "${FIXTURE}"`;
const TITLE = 'Studio Native Fixture';
// Cartella di progetto usa e getta: lì Studio scrive .claude/studio
const projectDir = mkdtempSync(path.join(os.tmpdir(), 'rls-window-project-'));
// Il codice dell'app nel progetto: Studio vi cerca i controlli annotati (sorgente probabile)
copyFileSync(FIXTURE, path.join(projectDir, 'native-app.ps1'));
const { check, summary } = suite('Riverloop Studio e2e — modalità window — finestra Windows Forms');
const probe = createCapturer().capturer;

/** La finestra dell'app di prova vista dal sistema (per conoscere posizioni ed elementi veri). */
const fixtureWindow = async () => (await probe.list(null, TITLE)).find((w) => w.title === TITLE);
/**
 * Elemento dell'interfaccia nativa in un punto noto della finestra di prova (le coordinate sono
 * quelle dell'app, uguali su ogni schermo: vedi test/fixtures/native-app.ps1).
 */
const KNOWN = { Salva: [336, 119], 'Rossi Mario': [120, 163] };
async function findElement(name) {
  const w = await fixtureWindow();
  assert(w, 'finestra di prova non trovata');
  const [x, y] = KNOWN[name];
  const el = await probe.elementAt(w.id, x, y);
  assert(el?.name === name, `in (${x}, ${y}) c'è ${el ? `${el.role} «${el.name}»` : 'nulla'}, non «${name}»`);
  return el;
}
const win32 = (action) =>
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Add-Type -Name W -Namespace Rls -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);'; $p = Get-Process | Where-Object { $_.MainWindowTitle -eq '${TITLE}' } | Select-Object -First 1; if (-not $p) { 'none' } elseif ('${action}' -eq 'minimize') { [void][Rls.W]::ShowWindow($p.MainWindowHandle, 6); 'ok' } else { [Rls.W]::IsIconic($p.MainWindowHandle) }`,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  ).trim();

/** Punto della finestra (pixel dell'immagine) → punto nella pagina Studio. */
async function at(page, x, y) {
  const c = await canvasBox(page);
  assert(c.logicalWidth > 0, 'nessuna immagine sulla tela');
  return [c.left + (x * c.width) / c.logicalWidth, c.top + (y * c.height) / c.logicalHeight];
}
const canvasHash = (page) =>
  page.evaluate(() => {
    const c = document.getElementById('app-canvas');
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0;
    for (let i = 0; i < data.length; i += 97) h = (h * 31 + data[i]) | 0;
    return h;
  });
const live = (page) => page.evaluate(() => document.getElementById('app-notice').hidden && document.getElementById('app-frozen').hidden);

let studio = startStudio(projectDir, ['--mode', 'window', '--app-cmd', APP_CMD, '--studio-port', '4790'], { RLS_FIXTURE_QUIET: '1' });
let browser;
let page;

try {
  const url = await studio.url();

  await check("Studio avvia l'app e trova la sua finestra", async () => {
    const m = await waitFor(() => /Finestra dell'app trovata: (.+)/.exec(studio.out()), 60000, 200, 'finestra trovata');
    assert(m[1].trim() === TITLE, `titolo: ${m[1]}`);
    return m[1].trim();
  });

  ({ browser, page } = await openStudio(url));

  await check("la pagina Studio mostra l'immagine della finestra e la aggiorna dal vivo", async () => {
    await waitFor(async () => (await canvasBox(page)).pixels > 10000, 20000, 200, 'immagine sulla tela');
    await waitFor(() => page.evaluate(() => document.getElementById('desk-title').textContent.length > 0), 8000, 200, 'titolo della finestra');
    const state = await page.evaluate(() => ({
      title: document.getElementById('desk-title').textContent,
      kind: document.getElementById('desk-kind').textContent,
      chip: document.querySelector('#dev-chip .label').textContent,
      back: document.getElementById('nav-back').hidden,
      frame: document.getElementById('app-frame').hidden,
    }));
    assert(state.title.includes(TITLE) && state.kind === 'Finestra', JSON.stringify(state));
    assert(state.chip === 'App avviata' && state.back && state.frame, JSON.stringify(state));
    const w = await fixtureWindow();
    const c = await page.evaluate(() => ({ w: document.getElementById('app-canvas').width, h: document.getElementById('app-canvas').height }));
    const box = await canvasBox(page);
    assert(
      box.logicalWidth === w.width && box.logicalHeight === w.height,
      `dimensione: tela ${box.logicalWidth}×${box.logicalHeight}, finestra ${w.width}×${w.height}`,
    );
    assert(Math.abs(c.w / c.h - w.width / w.height) < 0.02, `proporzioni: tela ${c.w}×${c.h}, finestra ${w.width}×${w.height}`);
    // L'app cambia ogni secondo (contatore): l'immagine deve seguirla
    const first = await canvasHash(page);
    await waitFor(async () => (await canvasHash(page)) !== first, 6000, 250, 'immagine aggiornata');
    await shot(page, 'window-1-live');
    return `${w.width}×${w.height}`;
  });

  await check('strumento Elemento: riconosce i controlli nativi (UI Automation)', async () => {
    const button = await findElement('Salva');
    await page.click('[data-mode="select"]');
    const center = [button.rect.x + button.rect.width / 2, button.rect.y + button.rect.height / 2];
    await page.mouse.move(...(await at(page, ...center)));
    await waitFor(
      () => page.evaluate(() => /Button «Salva»/.test(document.querySelector('.im-hover-label')?.textContent ?? '')),
      8000,
      150,
      'evidenziazione del pulsante',
    );
    const hover = await page.textContent('.im-hover-label');
    assert(hover.includes(`${button.rect.width}×${button.rect.height}`), `misura dell'elemento: ${hover}`);
    await shot(page, 'window-2-hover');
    await page.mouse.click(...(await at(page, ...center)));
    await page.waitForSelector('#cbox:not([hidden])', { timeout: 8000 });
    const target = await page.textContent('#cbox-target');
    assert(target.includes('Button «Salva»') && target.includes(`${button.rect.width}×${button.rect.height}`), `bersaglio: ${target}`);
    assert(!(await page.evaluate(() => document.getElementById('app-frozen').hidden)), "immagine non ferma durante l'annotazione");
    await comment(page, 'pulsante più largo');
    await waitFor(async () => (await pending(page)) === 1, 5000, 100, 'annotazione in sospeso');
    return target.trim();
  });

  await check("strumenti Riquadro e Disegno sull'immagine ferma", async () => {
    const list = await findElement('Rossi Mario');
    await page.click('[data-mode="area"]');
    const [x0, y0] = await at(page, list.rect.x, list.rect.y - 4);
    const [x1, y1] = await at(page, list.rect.x + 220, list.rect.y + 60);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 3 });
    await page.mouse.move(x1, y1, { steps: 3 });
    await page.mouse.up();
    await comment(page, 'righe più alte');
    await page.click('[data-mode="draw"]');
    const [dx, dy] = await at(page, 30, 100);
    await page.mouse.move(dx, dy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(dx + i * 10, dy + (i % 2 ? 3 : -3));
    await page.mouse.up();
    await comment(page, 'titolo sottolineato');
    await waitFor(async () => (await pending(page)) === 3, 5000, 100, 'tre annotazioni');
    await waitFor(
      () => page.evaluate(() => [...document.querySelectorAll('#tray-list .thumb')].every((t) => t.style.backgroundImage)),
      8000,
      200,
      'screenshot delle annotazioni',
    );
    // L'immagine resta ferma (il contatore dell'app avanza, la tela no) e mostra i tre segni
    const frozen = await canvasHash(page);
    await sleep(1600);
    assert((await canvasHash(page)) === frozen, "l'immagine è cambiata mentre si annotava");
    assert((await page.evaluate(() => [...document.querySelectorAll('.im-badge')].filter((b) => b.style.display !== 'none').length)) === 3, 'segni mancanti');
    await shot(page, 'window-3-tools');
  });

  await check('"torna dal vivo": l\'immagine riparte, le annotazioni restano da inviare', async () => {
    await page.click('#app-frozen');
    const before = await canvasHash(page);
    await waitFor(async () => (await canvasHash(page)) !== before, 6000, 250, 'immagine dal vivo');
    assert((await pending(page)) === 3, 'annotazioni perse');
    assert(
      (await page.evaluate(() => [...document.querySelectorAll('.im-badge')].filter((b) => b.style.display !== 'none').length)) === 0,
      "segni rimasti sull'immagine dal vivo",
    );
    // Dal vassoio si torna all'immagine su cui è stata fatta l'annotazione
    await page.click('#tray-list .tray-item');
    await waitFor(() => page.evaluate(() => !document.getElementById('app-frozen').hidden), 3000, 100, 'ritorno al fermo immagine');
  });

  await check('invio: messaggio per Claude con finestra, elemento nativo, posizioni e immagini', async () => {
    await page.click('[data-mode="navigate"]');
    await page.click('#btn-send');
    const pasted = await waitFor(
      () => studio.fakeEvents().find((e) => e.event === 'input' && String(e.data).includes('Modifiche richieste')),
      15000,
      200,
      'messaggio incollato',
    );
    const text = String(pasted.data);
    assert(text.includes(`finestra «${TITLE}» dell'app desktop`), `intestazione: ${text.slice(0, 160)}`);
    assert(text.includes('Elemento `Button «Salva»` (AutomationId `btnSalva`'), 'elemento nativo mancante');
    assert(/Posizione nella finestra: x \d+–\d+, y \d+–\d+ px/.test(text), 'posizione mancante');
    // Riquadro sull'elenco: i controlli che contiene; elemento: la riga del codice che lo crea
    assert(/Contiene: [^\n]*Rossi Mario/.test(text), `controlli nella zona mancanti: ${text.match(/Contiene:[^\n]*/)?.[0] ?? '(nessuna riga Contiene)'}`);
    assert(text.includes('`native-app.ps1:51`'), `sorgente probabile mancante: ${text.match(/Probabile codice[^\n]*/)?.[0] ?? '(nessuna)'}`);
    assert(text.includes('Finestra intera con le annotazioni 1, 2, 3:'), 'finestra intera mancante');
    const dir = path.join(projectDir, '.claude', 'studio', 'annotations');
    const files = readdirSync(dir);
    const pngs = files.filter((f) => f.endsWith('.png'));
    assert(pngs.length === 4 && pngs.every((f) => isPng(path.join(dir, f), 800)), `immagini: ${files.join(', ')}`);
    assert(
      pngs.some((f) => f.includes('-finestra-1')),
      'immagine della finestra intera mancante',
    );
    const json = JSON.parse(
      readFileSync(
        path.join(
          dir,
          files.find((f) => f.endsWith('.json')),
        ),
        'utf8',
      ),
    );
    assert(json.annotations.length === 3 && json.annotations.every((a) => a.surface === 'window' && a.windowScreenshot), 'JSON incompleto');
    assert(json.annotations[0].native.automationId === 'btnSalva' && json.annotations[0].native.framework === 'WinForm', 'elemento nativo nel JSON');
    // Fatte le annotazioni, l'immagine torna dal vivo da sola
    await waitFor(async () => (await pending(page)) === 0 && (await live(page)), 8000, 200, 'ritorno dal vivo');
    return `${pngs.length} immagini`;
  });

  await check('finestra ridotta a icona: avviso e "Mostra la finestra"', async () => {
    assert(win32('minimize') === 'ok', 'finestra non ridotta');
    await page.waitForSelector('#app-notice:not([hidden])', { timeout: 8000 });
    assert((await page.textContent('#app-notice-text')).includes('ridotta a icona'), 'avviso sbagliato');
    await page.click('#app-notice-show');
    await waitFor(async () => (await live(page)) && win32('state') === 'False', 8000, 250, 'finestra di nuovo visibile');
  });

  await check('"Riavvia app" e riavvio a fine risposta (hook di Claude Code)', async () => {
    const pidOf = async () => (await fixtureWindow())?.pid;
    const first = await pidOf();
    await page.click('#app-restart');
    const second = await waitFor(
      async () => {
        const pid = await pidOf();
        return pid && pid !== first ? pid : null;
      },
      30000,
      300,
      'nuova finestra dopo il riavvio',
    );
    await waitFor(() => live(page), 15000, 200, 'immagine dal vivo');
    await page.click('#idle-switch');
    await page.click('#terminal');
    await page.keyboard.type('fai una MODIFICA');
    await page.keyboard.press('Enter');
    await waitFor(() => /riavvio dell'app/.test(studio.out()), 10000, 200, 'riavvio a fine risposta');
    await waitFor(
      async () => {
        const pid = await pidOf();
        return pid && pid !== second;
      },
      30000,
      300,
      'nuova finestra dopo la risposta',
    );
    await waitFor(() => live(page), 15000, 200, 'immagine dal vivo');
  });

  await check("chiusura: Studio chiude anche la finestra dell'app", async () => {
    const exit = await studio.shutdown(page);
    assert(exit.code === 0, `uscita ${JSON.stringify(exit)}`);
    await waitFor(async () => !(await fixtureWindow()), 10000, 300, 'finestra chiusa');
  });
  await browser.close();
  browser = null;
  studio.cleanup();

  // --- App già aperta: aggancio per titolo, senza avviarla né chiuderla ---
  const external = spawn(APP_CMD, { shell: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, RLS_FIXTURE_QUIET: '1' } });
  try {
    await waitFor(fixtureWindow, 30000, 300, 'app esterna avviata');
    studio = startStudio(projectDir, ['--mode', 'window', '--no-dev', '--window-title', 'Native Fixture', '--studio-port', '4790']);
    ({ browser, page } = await openStudio(await studio.url()));
    await check('--no-dev --window-title: aggancio a una finestra già aperta', async () => {
      await waitFor(async () => (await canvasBox(page)).pixels > 10000 && (await live(page)), 20000, 200, 'immagine della finestra');
      const state = await page.evaluate(() => ({
        chip: document.querySelector('#dev-chip .label').textContent,
        restart: document.getElementById('app-restart').hidden,
        idle: document.getElementById('idle-switch').hidden,
      }));
      assert(state.chip === 'App collegata · esterna' && state.restart && state.idle, JSON.stringify(state));
      const exit = await studio.shutdown(page);
      assert(exit.code === 0, `uscita ${JSON.stringify(exit)}`);
      assert(await fixtureWindow(), "Studio ha chiuso un'app che non aveva avviato");
    });
    await browser.close();
    browser = null;
    studio.cleanup();

    // --- Senza cattura dal sistema: la finestra si condivide dal browser ---
    studio = startStudio(projectDir, ['--mode', 'window', '--no-dev', '--window-title', 'Native Fixture', '--studio-port', '4790'], {
      RIVERLOOP_STUDIO_NO_CAPTURE: '1',
    });
    // Il browser del test sceglie da solo la finestra da condividere (niente finestra di scelta)
    ({ browser, page } = await openStudio(await studio.url(), { args: [`--auto-select-desktop-capture-source=${TITLE}`] }));
    await check("cattura non disponibile: condivisione della finestra dal browser, Riquadro sull'immagine condivisa", async () => {
      await page.waitForSelector('#app-notice:not([hidden])', { timeout: 8000 });
      assert(await page.isVisible('#app-notice-share'), 'pulsante di condivisione mancante');
      await page.click('#app-notice-share');
      await waitFor(
        async () => (await canvasBox(page)).pixels > 10000 && (await page.evaluate(() => document.getElementById('app-notice').hidden)),
        15000,
        200,
        'immagine condivisa',
      );
      // Senza il sistema Studio non riconosce gli elementi: lo dice, e Riquadro funziona
      await page.click('[data-mode="select"]');
      await waitFor(
        () => page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('non riconosce gli elementi'))),
        3000,
        100,
        'avviso sullo strumento Elemento',
      );
      await page.click('[data-mode="area"]');
      const c = await canvasBox(page);
      await page.mouse.move(c.left + c.width * 0.2, c.top + c.height * 0.3);
      await page.mouse.down();
      await page.mouse.move(c.left + c.width * 0.5, c.top + c.height * 0.5, { steps: 4 });
      await page.mouse.up();
      await comment(page, 'zona sulla finestra condivisa');
      await waitFor(async () => (await pending(page)) === 1, 5000, 100, 'annotazione in sospeso');
      await page.click('#btn-send');
      const pasted = await waitFor(
        () => studio.fakeEvents().find((e) => e.event === 'input' && String(e.data).includes('Modifiche richieste')),
        15000,
        200,
        'messaggio incollato',
      );
      assert(String(pasted.data).includes('Zona di ') && String(pasted.data).includes('Finestra intera con'), 'messaggio incompleto');
      const exit = await studio.shutdown(page);
      assert(exit.code === 0, `uscita ${JSON.stringify(exit)}`);
    });
  } finally {
    try {
      execFileSync('taskkill', ['/pid', String(external.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* già chiusa */
    }
  }
} catch (err) {
  console.error(`\nErrore del test: ${err?.stack || err}\n--- output di Studio ---\n${studio.out().slice(-3000)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  studio.kill();
  probe.dispose();
  await sleep(300);
  studio.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
}
const failed = summary();
if (failed) {
  console.log(`--- output di Studio ---\n${studio.out().slice(-2500)}`);
  process.exitCode = 1;
}

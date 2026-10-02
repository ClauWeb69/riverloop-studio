// App Electron minima per i test end-to-end di Riverloop Studio (modalità electron).
// Con RLS_FIXTURE_QUIET=1 non disturba chi sta usando il computer: le finestre nascono ridotte a
// icona e su uno schermo secondario (se c'è), così non compaiono sullo schermo principale e non
// ricevono clic veri. Studio le mostra comunque, perché tiene attivo il disegno delle finestre.
const { app, BrowserWindow, screen } = require('electron');
const path = require('node:path');

const quiet = process.env.RLS_FIXTURE_QUIET === '1';

/** Lo schermo secondario più piccolo, o null se c'è solo quello principale. */
function secondaryDisplay() {
  const primary = screen.getPrimaryDisplay().id;
  const others = screen.getAllDisplays().filter((d) => d.id !== primary);
  others.sort((a, b) => a.workArea.width * a.workArea.height - b.workArea.width * b.workArea.height);
  return others[0] ?? null;
}

/** Opzioni di una finestra: in modalità silenziosa non si mostra e sta sullo schermo secondario. */
function windowOptions(offset = 0) {
  const options = { width: 900, height: 640, autoHideMenuBar: true, show: !quiet };
  const display = quiet ? secondaryDisplay() : null;
  if (display) Object.assign(options, { x: display.workArea.x + 40 + offset, y: display.workArea.y + 40 + offset });
  return options;
}

app.on('browser-window-created', (_event, win) => {
  // Dopo la creazione, non durante: una finestra ridotta a icona prima di esistere resta di 0×0 pixel
  if (quiet) setImmediate(() => win.isDestroyed() || win.minimize());
});

app.whenReady().then(() => {
  const win = new BrowserWindow({ ...windowOptions(), title: 'Studio Electron Fixture' });
  // window.open (pulsante "Seconda finestra") apre un'altra finestra dell'app
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: windowOptions(60) }));
  win.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());

import { ClaudeBar } from './claudeBar';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import './desktop.css';
import type { PermissionsMode, StudioConfig } from '../shared/protocol';
import { AnnotationManager } from './annotations';
import { AppChannel } from './appChannel';
import { AppPanel } from './appPanel';
import { CodeHistory } from './codeHistory';
import { ConsolePanel } from './console';
import { ControlChannel } from './control';
import { pageLocale, rememberLocale, setPageLocale, t, translateDom } from './i18n';
import { hydrateIcons } from './icons';
import { LOCALES, LOCALE_NAMES, type Locale } from '../shared/i18n';
import { DEFAULT_FONT, prefs, type ThemeMode, type ViewMode } from './prefs';
import { ProjectsMenu } from './projects';
import { SessionTabs, sessionFromUrl } from './sessions';
import { Suggestions } from './suggestions';
import { $, isEditable, showFatal, toast } from './ui';

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function isDark(): boolean {
  const theme = prefs.get('theme');
  return theme === 'dark' || (theme === 'system' && darkQuery.matches);
}

function applyTheme(): boolean {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  return dark;
}

// ---------------------------------------------------------------------------
// Token di sessione: arriva nel frammento del link (#t=...), resta nel localStorage di questa
// origine (l'app, su un'altra porta, non può leggerlo) e non viaggia mai in un cookie.
// ---------------------------------------------------------------------------
const TOKEN_KEY = `riverloop-studio:token:${location.port}`;

/**
 * Token candidati, nell'ordine in cui provarli: quello del link (#t=, solo nel frammento, che
 * non arriva mai al server) e quello salvato. Il link non sostituisce quello salvato finché il
 * server non lo accetta: una pagina qualunque può aprire Studio con un token falso nel link, e
 * non deve poter cancellare quello buono.
 */
function tokenCandidates(): string[] {
  const out: string[] = [];
  const m = /^#(?:.*&)?t=([0-9a-f]{64})(?:&|$)/.exec(location.hash);
  if (m) {
    out.push(m[1]);
    // Il token esce dalla barra degli indirizzi; resta l'eventuale scheda scelta (?s=)
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  try {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved && /^[0-9a-f]{64}$/.test(saved) && !out.includes(saved)) out.push(saved);
  } catch {
    /* storage non disponibile */
  }
  return out;
}

function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage non disponibile: il token resta solo in questa scheda */
  }
}

function forgetToken(token: string): void {
  try {
    if (localStorage.getItem(TOKEN_KEY) === token) localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignorato */
  }
}

/** Il primo token accettato dal server (che diventa quello salvato), con la configurazione. */
async function authenticate(): Promise<{ token: string; config: StudioConfig } | null> {
  const candidates = tokenCandidates();
  if (!candidates.length) {
    showFatal(t('fatal.openFromTerminal'), t('fatal.noToken'));
    return null;
  }
  for (const token of candidates) {
    const result = await loadConfig(token);
    if (result === 'unauthorized') {
      // Solo un token salvato e rifiutato si dimentica (Studio è stato riavviato con uno nuovo)
      forgetToken(token);
      continue;
    }
    if (!result) return null;
    storeToken(token);
    return { token, config: result };
  }
  showFatal(t('fatal.openFromTerminal'), t('fatal.noToken'));
  return null;
}

async function loadConfig(token: string): Promise<StudioConfig | 'unauthorized' | null> {
  const headers = { 'X-Studio-Token': token };
  try {
    // Imposta il cookie dell'iframe (valido solo per il proxy dell'app) e legge la configurazione.
    const session = await fetch('/api/session', { method: 'POST', headers, cache: 'no-store' });
    if (session.status === 401) return 'unauthorized';
    const res = await fetch('/api/config', { headers, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as StudioConfig;
  } catch {
    showFatal(t('fatal.unreachable.title'), t('fatal.unreachable'));
    return null;
  }
}

/** Il markup è tradotto: la pagina si può mostrare. */
function revealPage(): void {
  document.documentElement.setAttribute('data-i18n-ready', '');
}

// ---------------------------------------------------------------------------
// Lingua: scelta salvata dal companion (vale per tutte le pagine Studio aperte)
// ---------------------------------------------------------------------------
let reloadingForLocale = false;

/** Ricarica la pagina nella nuova lingua (stesso indirizzo, stessa scheda della console). */
function reloadForLocale(locale: Locale): void {
  if (reloadingForLocale || locale === pageLocale()) return;
  reloadingForLocale = true;
  rememberLocale(locale);
  location.reload();
}

function setupLanguage(config: StudioConfig, authHeaders: () => Record<string, string>): void {
  const select = $('set-locale') as HTMLSelectElement;
  for (const locale of LOCALES) {
    const option = document.createElement('option');
    option.value = locale;
    option.textContent = LOCALE_NAMES[locale];
    option.lang = locale;
    select.appendChild(option);
  }
  let chosen = config.localeChosen ? config.locale : 'auto';
  select.value = chosen;
  select.addEventListener('change', async () => {
    const value = select.value;
    select.disabled = true;
    try {
      const res = await fetch('/api/locale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ locale: value === 'auto' ? null : value }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; locale?: Locale; error?: string };
      if (!res.ok || !body.ok || !body.locale) throw new Error(body.error || `HTTP ${res.status}`);
      chosen = value;
      // Stessa lingua di prima (es. da "Italiano" ad "Automatica" su un sistema italiano): niente da ricaricare
      reloadForLocale(body.locale);
    } catch (err) {
      select.value = chosen;
      toast(t('settings.languageFailed', { error: (err as Error).message }), 'error');
    } finally {
      select.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Split view: divisore trascinabile, inversione dei lati, pannelli nascosti
// ---------------------------------------------------------------------------
function setupLayout(consolePanel: ConsolePanel): void {
  const workspace = $('workspace');
  const paneApp = $('pane-app');
  const divider = $('divider');

  const applySplit = (pct: number) => {
    paneApp.style.flexBasis = `${pct}%`;
    divider.setAttribute('aria-valuenow', String(Math.round(pct)));
  };
  const setView = (view: ViewMode) => {
    workspace.dataset.view = view;
    prefs.set('view', view);
    $('view-app').classList.toggle('active', view === 'app');
    $('view-split').classList.toggle('active', view === 'split');
    $('view-console').classList.toggle('active', view === 'console');
    consolePanel.scheduleFit();
  };

  applySplit(prefs.get('split'));
  workspace.classList.toggle('swapped', prefs.get('swapped'));
  setView(prefs.get('view'));

  const clamp = (v: number) => Math.min(85, Math.max(15, v));
  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    workspace.classList.add('resizing');
    const rect = workspace.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const swapped = workspace.classList.contains('swapped');
      const x = swapped ? rect.right - ev.clientX : ev.clientX - rect.left;
      applySplit(clamp((x / rect.width) * 100));
    };
    const up = () => {
      workspace.classList.remove('resizing');
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      divider.removeEventListener('pointercancel', up);
      prefs.set('split', parseFloat(paneApp.style.flexBasis) || 60);
      consolePanel.scheduleFit();
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
    divider.addEventListener('pointercancel', up);
  });
  divider.addEventListener('dblclick', () => {
    applySplit(60);
    prefs.set('split', 60);
  });
  divider.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const swapped = workspace.classList.contains('swapped');
    const dir = (e.key === 'ArrowRight' ? 1 : -1) * (swapped ? -1 : 1);
    const next = clamp((parseFloat(paneApp.style.flexBasis) || 60) + dir * 2);
    applySplit(next);
    prefs.set('split', next);
  });

  $('btn-swap').addEventListener('click', () => {
    const swapped = !workspace.classList.contains('swapped');
    workspace.classList.toggle('swapped', swapped);
    prefs.set('swapped', swapped);
  });
  $('view-app').addEventListener('click', () => setView(workspace.dataset.view === 'app' ? 'split' : 'app'));
  $('view-split').addEventListener('click', () => setView('split'));
  $('view-console').addEventListener('click', () => setView(workspace.dataset.view === 'console' ? 'split' : 'console'));
}

// ---------------------------------------------------------------------------
// Impostazioni: tema, carattere della console, schermo intero
// ---------------------------------------------------------------------------
function setupSettings(consolePanel: ConsolePanel): void {
  const popover = $('settings');
  const button = $('btn-settings');
  const theme = $('set-theme') as HTMLSelectElement;
  const font = $('set-font') as HTMLInputElement;
  const size = $('set-size') as HTMLInputElement;

  const syncFields = () => {
    theme.value = prefs.get('theme');
    font.value = prefs.get('fontFamily');
    size.value = String(prefs.get('fontSize'));
  };
  const applyFont = () => consolePanel.setFont(prefs.get('fontFamily') || DEFAULT_FONT, prefs.get('fontSize'));

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!popover.hidden) {
      popover.hidden = true;
      return;
    }
    syncFields();
    const r = button.getBoundingClientRect();
    popover.style.top = `${r.bottom + 6}px`;
    popover.style.left = `${Math.max(8, Math.min(window.innerWidth - 290, r.right - 280))}px`;
    popover.hidden = false;
  });
  document.addEventListener('pointerdown', (e) => {
    if (!popover.hidden && !popover.contains(e.target as Node) && e.target !== button) popover.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) popover.hidden = true;
  });

  theme.addEventListener('change', () => {
    prefs.set('theme', theme.value as ThemeMode);
    consolePanel.setDark(applyTheme());
  });
  darkQuery.addEventListener('change', () => consolePanel.setDark(applyTheme()));
  font.addEventListener('change', () => {
    prefs.set('fontFamily', font.value.trim() || DEFAULT_FONT);
    applyFont();
  });
  size.addEventListener('change', () => {
    const v = Math.min(28, Math.max(9, Math.round(Number(size.value) || 14)));
    prefs.set('fontSize', v);
    applyFont();
  });
  const bump = (d: number) => {
    prefs.set('fontSize', Math.min(28, Math.max(9, prefs.get('fontSize') + d)));
    applyFont();
  };
  $('font-down').addEventListener('click', () => bump(-1));
  $('font-up').addEventListener('click', () => bump(1));

  // Schermo intero con Keyboard Lock: così Ctrl+W, Ctrl+T e Ctrl+N arrivano a Claude Code.
  const fsButton = $('btn-fullscreen');
  fsButton.addEventListener('click', async () => {
    const nav = navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void } };
    if (document.fullscreenElement) {
      nav.keyboard?.unlock?.();
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    try {
      await document.documentElement.requestFullscreen();
      await nav.keyboard?.lock?.(['KeyW', 'KeyT', 'KeyN']);
    } catch {
      /* non supportato */
    }
    consolePanel.focus();
  });
  document.addEventListener('fullscreenchange', () => fsButton.classList.toggle('on', Boolean(document.fullscreenElement)));
}

// ---------------------------------------------------------------------------
// Permessi di Claude Code: quelli standard (modalità e impostazioni di Claude Code) oppure
// --dangerously-skip-permissions
// ---------------------------------------------------------------------------
function setupPermissions(consolePanel: ConsolePanel, tabs: SessionTabs, runningAsRoot: boolean): void {
  const chip = $('btn-perms');
  const popover = $('perms');
  const radios = () => Array.from(popover.querySelectorAll<HTMLInputElement>('input[name="perm"]'));

  const render = (value: PermissionsMode) => {
    chip.dataset.mode = value;
    $('perm-label').textContent = value === 'skip' ? t('perms.skipLabel') : t('perms.standard');
    chip.title = value === 'skip' ? t('perms.chipSkip') : t('perms.chipAsk');
  };
  render(consolePanel.permissions);
  consolePanel.onPermissions = (value) => render(value);

  const close = () => {
    popover.hidden = true;
  };
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!popover.hidden) return close();
    radios().forEach((r) => (r.checked = r.value === consolePanel.permissions));
    const who = tabs.activeLabel();
    $('perm-note').textContent = consolePanel.running ? t('perms.noteRunning', { who }) : t('perms.noteStopped', { who });
    if (runningAsRoot) {
      $('perm-note').textContent += ` ${t('perms.rootWarning')}`;
    }
    const r = chip.getBoundingClientRect();
    popover.style.top = `${r.bottom + 6}px`;
    popover.style.left = `${Math.max(8, Math.min(window.innerWidth - 340, r.right - 330))}px`;
    popover.hidden = false;
  });
  $('perm-cancel').addEventListener('click', close);
  $('perm-apply').addEventListener('click', () => {
    const chosen = radios().find((r) => r.checked)?.value as PermissionsMode | undefined;
    close();
    if (!chosen || chosen === consolePanel.permissions) return;
    consolePanel.requestPermissions(chosen);
    consolePanel.focus();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!popover.hidden && !popover.contains(e.target as Node) && !chip.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) close();
  });
}

// ---------------------------------------------------------------------------
// Scorciatoie del pannello app (quelle dentro l'iframe le gestisce l'overlay)
// ---------------------------------------------------------------------------
function setupShortcuts(app: AppPanel, annotations: AnnotationManager): void {
  $('pane-app').addEventListener('keydown', (e) => {
    if (isEditable(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'enter') {
      e.preventDefault();
      void annotations.send();
      return;
    }
    if (mod && !e.shiftKey && key === 'z') {
      if (annotations.pendingCount) {
        e.preventDefault();
        annotations.undo();
      }
      return;
    }
    if (mod || e.altKey) return;
    const modes: Record<string, 'navigate' | 'select' | 'area' | 'draw'> = { escape: 'navigate', s: 'select', r: 'area', d: 'draw' };
    const mode = modes[key];
    if (mode && (mode !== 'navigate' || app.mode !== 'navigate')) {
      e.preventDefault();
      app.setMode(mode);
    }
  });
}

async function boot(): Promise<void> {
  // Prima la lingua ricordata (o del browser), poi quella decisa dal companion
  translateDom();
  hydrateIcons();
  const dark = applyTheme();
  const auth = await authenticate();
  if (!auth) return;
  const { token, config } = auth;
  setPageLocale(config.locale);
  revealPage();
  $('project-name').textContent = config.project;
  document.title = `${config.project} · Riverloop Studio`;

  const wanted = sessionFromUrl();
  const firstSession = config.sessions.find((s) => s.id === wanted) ?? config.sessions[0];
  const consolePanel = new ConsolePanel({
    container: $('terminal'),
    dot: $('conn-dot'),
    sub: $('console-sub'),
    exitOverlay: $('exit-overlay'),
    exitDetail: $('exit-detail'),
    platform: config.platform,
    windowsBuild: config.windowsBuild,
    fontFamily: prefs.get('fontFamily') || DEFAULT_FONT,
    fontSize: prefs.get('fontSize'),
    dark,
    token,
    permissions: firstSession?.permissions ?? config.permissions,
    sessionId: firstSession?.id ?? '1',
  });
  const authHeaders = () => ({ 'X-Studio-Token': token });
  const annotations = new AnnotationManager(config.nextAnnotationId, config.autoSend, consolePanel, authHeaders);
  const tabs = new SessionTabs(config.sessions, consolePanel, authHeaders);
  annotations.targetName = () => tabs.activeLabel();
  annotations.isRunning = (id) => tabs.isRunning(id);
  const claudeBar = new ClaudeBar(tabs, consolePanel, authHeaders);
  tabs.onChange = () => {
    claudeBar.update();
    const who = tabs.activeLabel();
    $('btn-send').title = t('tools.send.titleTo', { name: who });
    document.title = `${config.project}${who === 'Claude Code' ? '' : ` · ${who}`} · Riverloop Studio`;
  };
  tabs.onChange();
  const desktop = config.mode !== 'web';
  // App desktop: i fotogrammi dell'app e i messaggi dell'overlay passano dal companion
  const channel = desktop ? new AppChannel(token) : null;
  const app = new AppPanel(
    config,
    {
      viewsFor: (url) => annotations.viewsFor(url),
      onOverlayMessage: (msg) => annotations.handle(msg),
      onOverlayReady: () => annotations.overlayRestarted(),
      beforeModeChange: () => annotations.resolveOpenBox(),
    },
    channel,
  );
  annotations.attach(app);
  const control = new ControlChannel(config.devServer, token, config.mode);
  control.onDevStatus = (status, previous) => {
    if (desktop) return;
    $('url-host').textContent = `localhost:${status.port}`;
    // Il dev server è passato a un'altra porta (conflitto all'avvio): ricarichiamo l'app.
    if (status.port !== previous.port) app.reload();
  };
  control.onSessions = (list) => tabs.update(list);
  if (desktop) {
    // Riavvio dell'app a fine risposta: vale per le app avviate da Studio
    const idleSwitch = $('restart-idle') as HTMLInputElement;
    $('idle-switch').hidden = !config.devServer.managed;
    idleSwitch.checked = config.restartOnIdle;
    idleSwitch.addEventListener('change', () => control.setRestartOnIdle(idleSwitch.checked));
    control.onRestartOnIdle = (value) => {
      idleSwitch.checked = value;
    };
    control.onIdle = (restarted) => {
      if (restarted) toast(t('idle.restarted'), 'ok');
      app.idle();
    };
  }
  const closed = () => {
    control.stop();
    channel?.stop();
    consolePanel.stop();
    showFatal(t('fatal.closed.title'), t(desktop ? 'fatal.closedApp' : 'fatal.closedWeb', { project: config.project }));
  };
  control.onShutdown = closed;
  // Lingua cambiata (da questa o da un'altra pagina Studio): la pagina si ricarica nella nuova
  control.onLocale = (locale) => reloadForLocale(locale);
  consolePanel.onUnauthorized = () => control.stop();
  const projects = new ProjectsMenu(authHeaders, config.platform);
  projects.onShutdownRequested = closed;

  // Annulla e Ripeti delle modifiche ai file del progetto
  const codeHistory = new CodeHistory(config.history, authHeaders);
  control.onHistory = (history) => codeHistory.update(history);

  // Suggerimenti per il progetto: compaiono quando la console è avviata, così un clic basta
  const suggestions = new Suggestions({
    authHeaders,
    target: () => ({ id: consolePanel.sessionId, name: tabs.activeLabel() }),
    focusConsole: () => consolePanel.focus(),
  });
  setTimeout(() => void suggestions.refresh(), 1500);

  setupLayout(consolePanel);
  setupSettings(consolePanel);
  setupLanguage(config, authHeaders);
  setupPermissions(consolePanel, tabs, config.runningAsRoot);
  setupShortcuts(app, annotations);
  consolePanel.focus();
  // Diagnostica di sola lettura (usata anche dai test end-to-end)
  Object.defineProperty(window, '__riverloopStudio', {
    value: Object.freeze({
      terminalText: () => consolePanel.text(),
      pending: () => annotations.pendingCount,
      session: () => consolePanel.sessionId,
    }),
  });
}

// La pagina si mostra comunque: dopo l'avvio, dopo un errore, o al più tardi dopo 3 secondi
setTimeout(revealPage, 3000);
boot().finally(revealPage);

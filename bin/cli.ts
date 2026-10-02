#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError, Option } from 'commander';
import open from 'open';
import { cleanupAnnotations } from '../src/server/annotations.js';
import type { AppBridge } from '../src/server/bridge.js';
import { DesktopApp } from '../src/server/desktop.js';
import { detectProject } from '../src/server/detect.js';
import { DevServer } from '../src/server/devserver.js';
import { electronEnv, ElectronBridge, electronModeNote, expandAppCommand } from '../src/server/electron.js';
import { proposeGitignore } from '../src/server/gitignore.js';
import { hookScriptAvailable, IdleTracker, prepareHookSettings } from '../src/server/hooks.js';
import { setLocale, t } from '../src/server/i18n.js';
import { startCompanion, type Companion, type DesktopOptions } from '../src/server/index.js';
import { overlayLoader } from '../src/server/overlay-source.js';
import { loadPty, type Permissions } from '../src/server/pty.js';
import { claimPort } from '../src/server/portlock.js';
import { addRecent, ensureRegistered, registerInstance, unregisterInstance } from '../src/server/projects.js';
import { SessionManager } from '../src/server/sessions.js';
import { generateToken, Security } from '../src/server/security.js';
import { readProjectState, updateProjectState } from '../src/server/state.js';
import { readUserProjectState, updateUserProjectState } from '../src/server/userState.js';
import {
  c,
  claudeFallbackLocations,
  delay,
  hasPackageJson,
  isWindows,
  killTree,
  log,
  resolveExecutable,
  runDir,
  runVersion,
  silenceKnownDeprecations,
  splitArgs,
} from '../src/server/util.js';
import { createCapturer } from '../src/server/wincapture.js';
import { normalizeLocale } from '../src/shared/i18n.js';
import { WindowBridge } from '../src/server/window.js';

silenceKnownDeprecations();

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new InvalidArgumentError(t('cli.port.invalid'));
  return n;
}

interface CliOptions {
  /** Non indicata: Studio riconosce il tipo di progetto (detect.ts). */
  mode?: 'web' | 'window' | 'electron';
  port: number;
  studioPort: number;
  devCmd: string;
  appCmd?: string;
  windowTitle?: string;
  cdpPort: number;
  appWindow: 'background' | 'normal';
  restartOnIdle?: boolean;
  dev: boolean;
  resume?: boolean;
  claudeArgs: string;
  claudeBin: string;
  autoSend?: boolean;
  open: boolean;
  permissions?: 'ask' | 'skip';
  dangerouslySkipPermissions?: boolean;
  debug?: boolean;
  lang?: string;
}

/**
 * --lang va applicato prima di costruire il programma: i testi dell'aiuto di commander si
 * scrivono subito. Vale solo per questo avvio (la scelta salvata la cambia la pagina Studio).
 */
function applyLangOption(argv: string[]): void {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    let value: string | undefined;
    if (arg === '--lang') {
      value = argv[++i];
      if (value === undefined || value.startsWith('-')) {
        log.error(t('lang.missing'));
        process.exit(1);
      }
    } else if (arg.startsWith('--lang=')) {
      value = arg.slice('--lang='.length);
    } else {
      continue;
    }
    const locale = normalizeLocale(value);
    if (!locale) {
      log.error(t('lang.invalid', { value }));
      process.exit(1);
    }
    setLocale(locale, true);
  }
}

applyLangOption(process.argv);

const program = new Command();
program
  .name('riverloop-studio')
  .description(t('cli.description'))
  .version(pkg.version, '-v, --version', t('cli.opt.version'))
  .helpOption('-h, --help', t('cli.opt.help'))
  .addOption(new Option('--mode <mode>', t('cli.opt.mode')).choices(['web', 'window', 'electron']))
  .addOption(new Option('--port <n>', t('cli.opt.port')).argParser(parsePort).default(3000))
  .addOption(new Option('--studio-port <n>', t('cli.opt.studioPort')).argParser(parsePort).default(4700))
  .option('--dev-cmd <cmd>', t('cli.opt.devCmd'), 'npm run dev')
  .option('--app-cmd <cmd>', t('cli.opt.appCmd'))
  .option('--window-title <testo>', t('cli.opt.windowTitle'))
  .addOption(new Option('--cdp-port <n>', t('cli.opt.cdpPort')).argParser(parsePort).default(9222))
  .addOption(new Option('--app-window <modo>', t('cli.opt.appWindow')).choices(['background', 'normal']).default('background'))
  .option('--restart-on-idle', t('cli.opt.restartOnIdle'))
  .option('--no-dev', t('cli.opt.noDev'))
  .option('--resume', t('cli.opt.resume'))
  .option('--claude-args <args>', t('cli.opt.claudeArgs'), '')
  .option('--claude-bin <path>', t('cli.opt.claudeBin'), 'claude')
  .option('--auto-send', t('cli.opt.autoSend'))
  .addOption(new Option('--permissions <mode>', t('cli.opt.permissions')).choices(['ask', 'skip']))
  .option('--dangerously-skip-permissions', t('cli.opt.skipPermissions'))
  .option('--no-open', t('cli.opt.noOpen'))
  .option('--debug', t('cli.opt.debug'))
  // Già applicata da applyLangOption: qui serve all'aiuto e a far accettare l'opzione
  .option('--lang <lang>', t('cli.opt.lang'))
  .showHelpAfterError();

program.parse();
const opts = program.opts<CliOptions>();
if (opts.debug) process.env.RIVERLOOP_STUDIO_DEBUG = '1';

/** Comando predefinito per avviare un'app Electron: lo script "dev" o "start" del progetto. */
function defaultElectronCommand(cwd: string): string | null {
  try {
    const scripts = (JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    if (scripts.dev) return 'npm run dev';
    if (scripts.start) return 'npm start';
  } catch {
    /* nessun package.json leggibile */
  }
  return null;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  // Senza --mode Studio guarda il progetto: dipendenze e file di progetto dicono che app è e come si
  // avvia. Ciò che è scritto sulla riga di comando vince sempre; i valori rilevati non si ricordano.
  const explicit = { mode: Boolean(opts.mode), appCmd: Boolean(opts.appCmd), devCmd: program.getOptionValueSource('devCmd') === 'cli' };
  const detection = opts.mode ? null : detectProject(cwd);
  const mode: CliOptions['mode'] & string = opts.mode ?? detection?.mode ?? (opts.appCmd ? 'window' : 'web');
  opts.mode = mode;
  if (detection) {
    if (!explicit.appCmd && detection.appCmd && mode !== 'web') opts.appCmd = detection.appCmd;
    if (!explicit.devCmd && detection.devCmd && mode === 'web') opts.devCmd = detection.devCmd;
    // App desktop riconosciuta ma senza un comando di avvio certo: si sceglie una finestra già aperta
    if (mode === 'window' && !opts.appCmd && opts.dev) opts.dev = false;
  }
  const desktopMode = mode !== 'web';
  console.log(
    `${c.brand('◆')} ${c.bold('Riverloop Studio')} ${c.dim(pkg.version)} ${c.dim('—')} ${path.basename(cwd)}${desktopMode ? c.dim(t('cli.banner.mode', { mode })) : ''}`,
  );

  if (detection) {
    log.info(t(`cli.detect.${detection.kind}`, { evidence: c.bold(detection.evidence), mode }));
    if (mode === 'window' && !opts.appCmd) log.dim(`  ${t('cli.detect.noEntry')}`);
    log.dim(`  ${t('cli.detect.override')}`);
  }

  // 1. Prerequisiti ----------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) {
    log.error(t('cli.node.old', { version: process.versions.node }));
    process.exit(1);
  }
  const claude = resolveExecutable(opts.claudeBin, opts.claudeBin === 'claude' ? claudeFallbackLocations() : []);
  if (!claude) {
    log.error(t('cli.claude.notFound', { bin: opts.claudeBin }));
    process.exit(1);
  }
  const version = runVersion(claude);
  if (!version.ok) {
    log.error(t('cli.claude.noVersion', { path: claude.path, output: version.output || t('cli.claude.noOutput') }));
    process.exit(1);
  }
  try {
    const pty = await loadPty();
    if (pty.name !== 'node-pty') log.dim(t('cli.pty', { name: pty.name }));
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }
  log.ok(`Claude Code ${c.dim(version.output.split('\n')[0])}`);
  if (!desktopMode && !hasPackageJson(cwd)) log.warn(t('cli.noPackageJson'));
  if (!desktopMode) {
    const ignored = [opts.appCmd && '--app-cmd', opts.windowTitle && '--window-title', opts.restartOnIdle && '--restart-on-idle'].filter(Boolean);
    if (ignored.length) log.warn(t('cli.webIgnored', { count: ignored.length, options: ignored.join(', ') }));
  }

  try {
    await proposeGitignore(cwd);
  } catch (err) {
    log.warn(t('cli.gitignore.failed', { message: (err as Error).message }));
  }
  const removed = await cleanupAnnotations(cwd).catch(() => 0);
  if (removed) log.dim(t('cli.cleanup', { count: removed }));

  // 2. Token di sessione -----------------------------------------------------
  const token = generateToken();
  const saved = await readProjectState(cwd);

  // 3. App da annotare: dev server (web) oppure app desktop -------------------
  let devServer: DevServer | null = null;
  let desktopApp: DesktopApp | null = null;
  let bridge: AppBridge | null = null;
  let devCommand: string | null = null;
  let appCommand: string | null = null;
  let devPort = opts.port;

  if (!desktopMode) {
    // Con più sessioni di Studio aperte (progetti diversi) la porta può essere già presa:
    // il dev server di questo progetto parte su una porta libera. Per agganciarsi a un server
    // già avviato si usa --no-dev.
    devCommand = opts.dev ? opts.devCmd : null;
    if (devCommand) {
      // La porta viene anche prenotata, così un'altra sessione avviata insieme non la sceglie.
      devPort = await claimPort(opts.port);
      if (devPort !== opts.port) {
        log.warn(t('cli.dev.portBusy', { port: opts.port, next: devPort }));
        log.dim(t('cli.dev.portBusyHint', { port: opts.port }));
      }
    }
    devServer = new DevServer({ command: devCommand, port: devPort, cwd });
    if (devCommand) {
      log.info(`${t('cli.dev.starting', { command: c.bold(devCommand) })} ${c.dim(t('cli.portNote', { port: devPort }))}`);
      devServer.start();
    }
  } else if (mode === 'electron') {
    // La pagina dell'app si raggiunge dalla porta di debug di Chromium (solo su 127.0.0.1).
    const base = opts.dev ? (opts.appCmd ?? defaultElectronCommand(cwd)) : null;
    if (opts.dev && !base) {
      log.error(t('cli.electron.noCommand'));
      process.exit(1);
    }
    const cdpPort = base ? await claimPort(opts.cdpPort, { host: '127.0.0.1' }) : opts.cdpPort;
    appCommand = base ? expandAppCommand(base, cdpPort) : null;
    desktopApp = new DesktopApp({ command: appCommand, cwd, env: appCommand ? electronEnv(cdpPort, process.env, opts.appWindow) : {}, port: cdpPort });
    bridge = new ElectronBridge({ app: desktopApp, port: cdpPort, overlayScript: overlayLoader({ bridge: true }) });
    if (appCommand) {
      log.info(`${t('cli.app.starting', { command: c.bold(appCommand) })} ${c.dim(t('cli.debugPortNote', { port: cdpPort }))}`);
      if (opts.appWindow === 'background') log.dim(t('cli.electron.background'));
      desktopApp.start();
    } else {
      log.info(t('cli.electron.attach', { port: cdpPort }));
    }
    log.dim(`  ${electronModeNote()}`);
  } else {
    appCommand = opts.dev ? (opts.appCmd ?? null) : null;
    if (opts.dev && !appCommand) {
      log.error(t('cli.window.noCommand'));
      process.exit(1);
    }
    const { capturer, reason } = createCapturer();
    desktopApp = new DesktopApp({ command: appCommand, cwd });
    bridge = new WindowBridge({ app: desktopApp, capturer, unavailable: reason, title: opts.windowTitle ?? '' });
    if (!capturer) log.warn(reason);
    if (appCommand) {
      log.info(t('cli.app.starting', { command: c.bold(appCommand) }));
      desktopApp.start();
    } else if (opts.windowTitle) {
      log.info(t('cli.window.searching', { title: opts.windowTitle }));
    } else {
      log.info(t('cli.window.choose'));
    }
  }

  // 4. Companion (pagina Studio + proxy) e sessione Claude --------------------
  const studioPort = await claimPort(opts.studioPort, { host: '127.0.0.1', exclude: [devPort], role: 'studio' });
  // Il proxy serve solo alle app web (iframe): nelle modalità desktop la porta non viene aperta
  const proxyPort = desktopMode ? studioPort + 1 : await claimPort(studioPort + 1, { host: '127.0.0.1', exclude: [devPort, studioPort], role: 'proxy' });
  if (studioPort !== opts.studioPort) log.warn(t('cli.studioPortBusy', { port: opts.studioPort, next: studioPort }));

  // Permessi: scelta da riga di comando (solo per questo avvio), altrimenti quella salvata
  // dalla pagina Studio per il progetto (salvata per l'utente, mai nel progetto: un file del
  // progetto non deve poter togliere le richieste di permesso), altrimenti quelli standard.
  let extraArgs = splitArgs(opts.claudeArgs);
  const cliPermissions: Permissions | undefined =
    opts.permissions ?? (opts.dangerouslySkipPermissions || extraArgs.includes('--dangerously-skip-permissions') ? 'skip' : undefined);
  const permissions: Permissions = cliPermissions ?? (await readUserProjectState(cwd)).permissions ?? 'ask';
  if (permissions === 'skip') {
    log.warn(t('cli.skipPermissions', { bold: c.bold(t('cli.skipPermissions.bold')) }));
  }

  // Hook e status line di Claude Code (passati con --settings, senza toccare le impostazioni
  // dell'utente): fine risposta per il riavvio delle app desktop, modello, effort e utilizzo
  // per la barra di Claude nella pagina.
  let idle: IdleTracker | null = null;
  let hooks = false;
  if (hookScriptAvailable()) {
    try {
      const setup = prepareHookSettings(extraArgs, cwd);
      extraArgs = setup.args;
      idle = new IdleTracker();
      idle.userStatusLine = setup.userStatusLine?.command ?? null;
      hooks = true;
    } catch (err) {
      log.warn(t('cli.hooks.unavailable', { message: (err as Error).message }));
    }
  }
  let desktop: DesktopOptions | null = null;
  if (desktopApp && bridge) {
    const restartOnIdle = hooks && desktopApp.managed && (opts.restartOnIdle ?? saved.restartOnIdle ?? false);
    if (opts.restartOnIdle && !desktopApp.managed) log.warn(t('cli.restartOnIdle.unmanaged'));
    if (restartOnIdle) log.info(t('cli.restartOnIdle.on'));
    desktop = {
      app: desktopApp,
      bridge,
      restartOnIdle,
      onRestartOnIdle: (value) => {
        log.info(t(value ? 'cli.restartOnIdle.enabled' : 'cli.restartOnIdle.disabled'));
        void updateProjectState(cwd, { restartOnIdle: value }).catch(() => undefined);
      },
    };
  }

  const security = new Security({ token, studioPort, proxyPort });
  // Sessioni di Claude Code (schede della console): la prima parte quando la pagina si
  // collega, le altre si aprono dalla pagina con "+".
  const hookEnv = idle;
  const sessions = new SessionManager({
    command: claude,
    extraArgs,
    cwd,
    permissions,
    env: hookEnv ? (id) => hookEnv.env(studioPort, id) : undefined,
    // Nomi dati alle schede: per conversazione, così riprendendola la scheda ritrova il suo nome
    savedNames: saved.sessionNames,
    onNamesChange: (sessionNames) => void updateProjectState(cwd, { sessionNames }).catch(() => undefined),
  });
  // Solo la prima sessione eredita un eventuale --continue/--resume da --claude-args
  sessions.create({ resumeFirst: Boolean(opts.resume), inheritResumeArgs: true });
  sessions.on('permissions', (s: { name: string }, value: Permissions) => {
    const who = sessions.size > 1 ? s.name : 'Claude Code';
    log.info(t(value === 'skip' ? 'cli.permissions.skip' : 'cli.permissions.ask', { who }));
    void updateUserProjectState(cwd, { permissions: value }).catch(() => undefined);
  });

  let companion: Companion | null = null;
  let shuttingDown = false;

  const hardKill = () => {
    // Non deve mai lanciare: è l'ultima difesa contro i processi orfani
    for (const s of sessions.all()) {
      try {
        const pid = s.pid;
        if (pid && s.state === 'running') killTree(pid, 'SIGKILL');
      } catch {
        /* ignorato */
      }
    }
    try {
      devServer?.killNow();
      desktopApp?.killNow();
    } catch {
      /* ignorato */
    }
    unregisterInstance();
  };

  const what = () => t(desktopMode ? 'cli.what.app' : 'cli.what.devServer');
  const stopApp = () => (devServer ?? desktopApp)?.stop().catch(() => undefined) ?? Promise.resolve();

  const shutdown = async (code: number) => {
    if (shuttingDown) {
      log.warn(t('cli.forceQuit'));
      hardKill();
      process.exit(code || 130);
    }
    shuttingDown = true;
    try {
      console.log('');
      log.info(t('cli.closing', { what: what() }));
      unregisterInstance();
      // Claude e l'app in parallelo: su Windows chiudendo la finestra ci sono pochi secondi.
      await Promise.all([sessions.stopAll(), stopApp()]);
      await companion?.close().catch(() => undefined);
      log.ok(t('cli.closed'));
    } catch (err) {
      log.error(t('cli.closeError', { message: (err as Error).message }));
      hardKill();
    } finally {
      process.exit(code);
    }
  };

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (isWindows) signals.push('SIGBREAK');
  for (const sig of signals) process.on(sig, () => void shutdown(0));
  process.on('exit', () => {
    // Ultima difesa contro i processi orfani, anche in caso di errore imprevisto.
    hardKill();
  });
  process.on('uncaughtException', (err) => {
    log.error(t('cli.unexpected', { message: err.stack || err.message }));
    void shutdown(1);
  });

  sessions.on('state', (s: { name: string }, state: string, exitCode: number | null) => {
    if (state === 'exited' && !shuttingDown) {
      const who = sessions.size > 1 ? s.name : 'Claude Code';
      log.warn(exitCode !== null ? t('cli.claude.exitedCode', { who, code: exitCode }) : t('cli.claude.exited', { who }));
    }
  });
  if (devServer) {
    const dev = devServer;
    dev.on('port', (port) => {
      log.info(t('cli.dev.port', { port }));
    });
    dev.on('exit', (code) => {
      if (shuttingDown) return;
      log.warn(code !== null ? t('cli.dev.exitedCode', { code }) : t('cli.dev.exited'));
      if (dev.status().log.some((l) => /EADDRINUSE|address already in use|port \d+ is (already )?in use|already in use/i.test(l))) {
        log.dim(t('cli.dev.fixedPort'));
      }
    });
  }
  desktopApp?.on('exit', (code: number | null) => {
    if (shuttingDown) return;
    log.warn(code !== null ? t('cli.app.exitedCode', { code }) : t('cli.app.exited'));
  });

  try {
    companion = await startCompanion({
      mode,
      cwd,
      version: pkg.version,
      studioPort,
      proxyPort,
      autoSend: Boolean(opts.autoSend),
      security,
      sessions,
      devServer,
      desktop,
      hooks: idle,
      // Percorso già risolto: un --claude-bin relativo non varrebbe nella cartella di un altro progetto
      claudeBin: opts.claudeBin === 'claude' ? undefined : claude.path,
      devCommand,
      onShutdown: () => void shutdown(0),
    });
  } catch (err) {
    log.error(t('cli.companion.failed', { message: (err as Error).message }));
    await stopApp();
    process.exit(1);
  }

  // La pagina Studio di ogni progetto aperto su questo computer può elencare questo e aprirlo.
  const studioUrl = `http://127.0.0.1:${studioPort}/#t=${token}`;
  const registryEntry = { project: path.basename(cwd), cwd, studioPort, url: studioUrl, token, startedAt: Date.now(), log: process.env.RIVERLOOP_STUDIO_LOG };
  try {
    registerInstance(registryEntry);
    // Opzioni di avvio diverse da quelle predefinite: il menu Progetti riaprirà il progetto così
    const launch = {
      ...(explicit.mode && mode !== 'web' ? { mode } : {}),
      ...(mode === 'web' && explicit.devCmd ? { devCmd: opts.devCmd } : {}),
      ...(mode === 'web' && opts.port !== 3000 ? { port: opts.port } : {}),
      ...(explicit.appCmd ? { appCmd: opts.appCmd } : {}),
      ...(opts.windowTitle ? { windowTitle: opts.windowTitle } : {}),
      ...(mode === 'electron' && opts.cdpPort !== 9222 ? { cdpPort: opts.cdpPort } : {}),
      ...(!opts.dev ? { noDev: true } : {}),
    };
    addRecent(cwd, launch);
    // Se la voce sparisce (cartella pulita, voce tolta per errore) la rimettiamo
    setInterval(() => {
      if (!shuttingDown) ensureRegistered(registryEntry);
    }, 20000).unref();
  } catch (err) {
    log.warn(t('cli.registry.failed', { message: (err as Error).message }));
    // Avviato dalla pagina di un altro progetto: senza registro nessuno potrebbe aprirlo o chiuderlo
    if (process.env.RIVERLOOP_STUDIO_DETACHED === '1') {
      await shutdown(1);
      return;
    }
  }

  let appLine = '';
  if (devServer) {
    // Attesa del dev server (o verifica di quello esistente)
    const ready = await devServer.waitReady(devCommand ? 60000 : 1500);
    if (ready) log.ok(t('cli.dev.ready', { port: devServer.port }));
    else if (devCommand && devServer.state === 'exited') log.warn(t('cli.dev.stoppedStarting'));
    else if (devCommand) log.warn(t('cli.dev.timeout', { port: devServer.port }));
    else log.warn(t('cli.dev.none', { port: devServer.port }));
    devServer.startMonitor();
    appLine = `http://localhost:${devServer.port} ${c.dim(t('cli.proxyNote', { port: proxyPort }))}`;
  } else if (desktopApp) {
    // Attesa della finestra dell'app (o della sua porta di debug)
    const app = desktopApp;
    const deadline = Date.now() + (app.managed ? 60000 : 4000);
    while (!app.isReady && app.state !== 'exited' && Date.now() < deadline) await delay(300);
    const title = companion && desktop ? desktop.bridge.view().title : '';
    if (app.isReady) {
      if (mode === 'electron') log.ok(title ? t('cli.electron.connectedTitle', { port: app.port, title }) : t('cli.electron.connected', { port: app.port }));
      else log.ok(title ? t('cli.window.foundTitle', { title }) : t('cli.window.found'));
    } else if (app.state === 'exited') log.warn(t('cli.app.stoppedStarting'));
    else if (mode === 'electron' && app.managed) {
      log.warn(t('cli.electron.timeout', { port: app.port }));
      log.dim(t('cli.electron.timeoutHint'));
    } else if (mode === 'electron') log.warn(t('electron.noApp', { port: app.port }));
    else if (app.managed) log.warn(t('cli.window.timeout'));
    if (mode === 'electron') appLine = t('cli.appLine.electron', { port: app.port });
    else appLine = opts.windowTitle ? t('cli.appLine.windowTitle', { title: opts.windowTitle }) : t('cli.appLine.window');
  }

  // 5. Browser --------------------------------------------------------------
  // Il token viaggia nel frammento (#): non compare in nessuna richiesta HTTP.
  console.log('');
  console.log(`  ${c.bold('Studio')}   ${c.cyan(studioUrl)}`);
  console.log(`  ${c.bold('App')}      ${appLine}`);
  console.log(`  ${c.dim(t('cli.tokenWarning'))}`);
  console.log('');
  if (opts.open) {
    try {
      await openStudio(studioUrl);
    } catch (err) {
      log.warn(t('cli.openFailed', { message: (err as Error).message }));
    }
  }
}

/**
 * Apre la pagina Studio nel browser. Su Linux e macOS il link non va sulla riga di comando del
 * browser: lì è leggibile da altri utenti della macchina (/proc/<pid>/cmdline, ps), e il token
 * nel link dà accesso alla console. Si apre invece un file locale leggibile solo dall'utente che
 * porta al link, cancellato poco dopo. Su Windows la riga di comando di un processo non è
 * leggibile da altri utenti senza privilegi di amministratore.
 */
async function openStudio(url: string): Promise<void> {
  if (isWindows) {
    await open(url);
    return;
  }
  const file = path.join(runDir('launch'), `studio-${randomBytes(12).toString('hex')}.html`);
  const html = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Riverloop Studio</title><script>location.replace(${JSON.stringify(url)})</script>`;
  writeFileSync(file, html, { mode: 0o600 });
  setTimeout(() => rmSync(file, { force: true }), 60_000).unref();
  process.on('exit', () => rmSync(file, { force: true }));
  await open(pathToFileURL(file).href);
}

main().catch((err) => {
  log.error((err as Error).stack || String(err));
  process.exit(1);
});

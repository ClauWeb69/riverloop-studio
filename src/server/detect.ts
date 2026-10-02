// Che tipo di app c'è nella cartella del progetto, e come si avvia. Serve a non dover scrivere
// --mode e --app-cmd: Studio guarda i file del progetto (dipendenze, file di progetto) e sceglie.
// Solo lettura, nessun comando eseguito. Un'opzione data sulla riga di comando vince sempre.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppMode } from '../shared/protocol.js';

export type DetectedKind = 'electron' | 'tauri' | 'web' | 'dotnet' | 'python' | 'flutter';

export interface Detection {
  kind: DetectedKind;
  mode: AppMode;
  /** Comando di avvio dell'app desktop (modalità electron e window). */
  appCmd?: string;
  /** Comando del dev server (modalità web). */
  devCmd?: string;
  /** Da cosa si è capito (per il messaggio all'avvio): nome di una dipendenza o di un file. */
  evidence: string;
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Il gestore di pacchetti del progetto, dal file di lock (npm se non si capisce). */
export function packageManager(cwd: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(cwd, 'bun.lockb')) || existsSync(path.join(cwd, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** "npm run dev", "pnpm dev", "yarn dev", "bun run dev"; per "start" anche "npm start". */
export function runScript(pm: ReturnType<typeof packageManager>, script: string): string {
  if (pm === 'npm') return script === 'start' ? 'npm start' : `npm run ${script}`;
  if (pm === 'bun') return `bun run ${script}`;
  return `${pm} ${script}`;
}

const WEB_FRAMEWORKS = [
  'next',
  'vite',
  'react-scripts',
  'nuxt',
  'astro',
  '@sveltejs/kit',
  '@remix-run/dev',
  'gatsby',
  '@angular/core',
  'webpack-dev-server',
  'parcel',
  '@vue/cli-service',
  'svelte',
  'react',
  'vue',
];
const PYTHON_GUI = ['PyQt6', 'PyQt5', 'PySide6', 'PySide2', 'kivy', 'wxPython', 'customtkinter', 'tkinter', 'pywebview', 'flet', 'dearpygui'];

/** File di progetto .NET di un'app desktop (nella cartella o in una sottocartella). */
function dotnetDesktopProject(cwd: string): string | null {
  const candidates: string[] = [];
  const scan = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.csproj')) candidates.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth > 0 && !/^(bin|obj|node_modules|\.)/.test(e.name)) scan(path.join(dir, e.name), depth - 1);
    }
  };
  scan(cwd, 2);
  for (const file of candidates.sort()) {
    const text = readText(file);
    const desktop = /<UseWPF>\s*true|<UseWindowsForms>\s*true|<UseMaui>\s*true|Avalonia|Microsoft\.WindowsAppSDK/i.test(text);
    if (desktop || /<OutputType>\s*WinExe/i.test(text)) return file;
  }
  return null;
}

/**
 * Riconosce il progetto nella cartella. null se non c'è niente di riconoscibile (allora vale la
 * modalità web, come sempre). Il primo indizio forte vince: un'app Electron ha anche uno script
 * "dev", ma va aperta come app desktop.
 */
export function detectProject(cwd: string, platform: NodeJS.Platform = process.platform): Detection | null {
  const pkg = readJson<PackageJson>(path.join(cwd, 'package.json'));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const scripts = pkg?.scripts ?? {};
  const pm = packageManager(cwd);
  const firstScript = (...names: string[]) => names.find((n) => scripts[n]);

  // Tauri: l'interfaccia è una pagina web dentro WebView2 (Windows) o WebKit (macOS, Linux)
  if (existsSync(path.join(cwd, 'src-tauri', 'tauri.conf.json')) || deps['@tauri-apps/cli']) {
    const appCmd = scripts.tauri ? runScript(pm, 'tauri dev') : 'npx tauri dev';
    // Solo WebView2 ha la porta di debug di Chromium; altrove si cattura la finestra
    return { kind: 'tauri', mode: platform === 'win32' ? 'electron' : 'window', appCmd, evidence: 'src-tauri/tauri.conf.json' };
  }

  if (deps.electron || deps['electron-nightly']) {
    const script = firstScript('dev', 'start', 'electron:dev', 'electron');
    return { kind: 'electron', mode: 'electron', appCmd: script ? runScript(pm, script) : 'npx electron .', evidence: 'electron' };
  }

  if (pkg) {
    const script = firstScript('dev', 'start', 'serve');
    if (script) {
      const framework = WEB_FRAMEWORKS.find((name) => deps[name]);
      return { kind: 'web', mode: 'web', devCmd: runScript(pm, script), evidence: framework ?? `"${script}" script` };
    }
  }

  const csproj = dotnetDesktopProject(cwd);
  if (csproj) {
    const rel = path.relative(cwd, csproj);
    return { kind: 'dotnet', mode: 'window', appCmd: rel.includes(path.sep) ? `dotnet run --project "${rel}"` : 'dotnet run', evidence: rel };
  }

  const pythonDeps = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'].map((f) => readText(path.join(cwd, f))).join('\n');
  const entry = ['main.py', 'app.py', '__main__.py', 'gui.py'].find((f) => existsSync(path.join(cwd, f)));
  const gui =
    PYTHON_GUI.find((name) => new RegExp(`\\b${name}\\b`, 'i').test(pythonDeps)) ??
    (entry && /^\s*(?:import|from)\s+(tkinter|PyQt[56]|PySide[26]|kivy|wx|customtkinter|webview|flet)\b/m.exec(readText(path.join(cwd, entry)))?.[1]);
  if (gui) {
    const python = platform === 'win32' ? 'python' : 'python3';
    return { kind: 'python', mode: 'window', appCmd: entry ? `${python} ${entry}` : undefined, evidence: gui };
  }

  const pubspec = readText(path.join(cwd, 'pubspec.yaml'));
  if (/^\s*flutter\s*:/m.test(pubspec)) {
    const device = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
    return { kind: 'flutter', mode: 'window', appCmd: `flutter run -d ${device}`, evidence: 'pubspec.yaml' };
  }

  return null;
}

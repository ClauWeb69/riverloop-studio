import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectProject, packageManager, runScript } from '../../src/server/detect.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-detect-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** Cartella di progetto con i file indicati (percorso relativo → contenuto). */
function project(files: Record<string, string | object>): string {
  const dir = path.join(tmp, `p${++n}`);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('riconoscimento del tipo di progetto', () => {
  it('app web: framework e script del gestore di pacchetti giusto', () => {
    expect(detectProject(project({ 'package.json': { scripts: { dev: 'next dev' }, dependencies: { next: '16', react: '19' } } }))).toEqual({
      kind: 'web',
      mode: 'web',
      devCmd: 'npm run dev',
      evidence: 'next',
    });
    const vite = project({ 'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '8' } }, 'pnpm-lock.yaml': '' });
    expect(detectProject(vite)).toMatchObject({ mode: 'web', devCmd: 'pnpm dev', evidence: 'vite' });
    expect(
      detectProject(project({ 'package.json': { scripts: { start: 'react-scripts start' }, dependencies: { 'react-scripts': '5' } }, 'yarn.lock': '' })),
    ).toMatchObject({ devCmd: 'yarn start' });
  });

  it('app Electron: vince sullo script "dev" di una pagina web', () => {
    const dir = project({ 'package.json': { scripts: { dev: 'electron-vite dev' }, devDependencies: { electron: '44', vite: '8' } } });
    expect(detectProject(dir)).toEqual({ kind: 'electron', mode: 'electron', appCmd: 'npm run dev', evidence: 'electron' });
    expect(detectProject(project({ 'package.json': { devDependencies: { electron: '44' } } }))).toMatchObject({ appCmd: 'npx electron .' });
  });

  it('app Tauri: WebView2 su Windows, cattura della finestra altrove', () => {
    const dir = project({
      'package.json': { scripts: { tauri: 'tauri', dev: 'vite' }, devDependencies: { '@tauri-apps/cli': '2' } },
      'src-tauri/tauri.conf.json': {},
    });
    expect(detectProject(dir, 'win32')).toMatchObject({ kind: 'tauri', mode: 'electron', appCmd: 'npm run tauri dev' });
    expect(detectProject(dir, 'darwin')).toMatchObject({ kind: 'tauri', mode: 'window' });
  });

  it('app .NET desktop, anche in una sottocartella', () => {
    expect(detectProject(project({ 'App.csproj': '<Project><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>' }))).toMatchObject({
      kind: 'dotnet',
      mode: 'window',
      appCmd: 'dotnet run',
    });
    const nested = detectProject(
      project({ 'src/Clienti/Clienti.csproj': '<Project><PropertyGroup><OutputType>WinExe</OutputType></PropertyGroup></Project>', 'README.md': '' }),
    );
    expect(nested).toMatchObject({ kind: 'dotnet', appCmd: `dotnet run --project "${path.join('src', 'Clienti', 'Clienti.csproj')}"` });
    // una libreria o un servizio web .NET non è un'app desktop
    expect(detectProject(project({ 'Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' }))).toBeNull();
  });

  it('app Python con interfaccia: dalle dipendenze o dagli import del file principale', () => {
    expect(detectProject(project({ 'requirements.txt': 'PySide6==6.8\n', 'main.py': 'print(1)' }), 'win32')).toMatchObject({
      kind: 'python',
      mode: 'window',
      appCmd: 'python main.py',
      evidence: 'PySide6',
    });
    expect(detectProject(project({ 'app.py': 'import tkinter as tk\n' }), 'linux')).toMatchObject({ appCmd: 'python3 app.py', evidence: 'tkinter' });
    // interfaccia riconosciuta ma nessun file principale: niente comando (si sceglie la finestra)
    expect(detectProject(project({ 'pyproject.toml': 'dependencies = ["PyQt6"]' }))).toMatchObject({ kind: 'python', appCmd: undefined });
    // uno script Python senza interfaccia non è un'app da annotare
    expect(detectProject(project({ 'main.py': 'import requests\n' }))).toBeNull();
  });

  it('app Flutter e cartella senza nulla di riconoscibile', () => {
    expect(detectProject(project({ 'pubspec.yaml': 'name: app\nflutter:\n  uses-material-design: true\n' }), 'win32')).toMatchObject({
      kind: 'flutter',
      appCmd: 'flutter run -d windows',
    });
    expect(detectProject(project({ 'notes.txt': 'ciao' }))).toBeNull();
    expect(detectProject(project({ 'package.json': { dependencies: { lodash: '4' } } }))).toBeNull();
  });

  it('gestore di pacchetti e comandi degli script', () => {
    expect(packageManager(project({ 'bun.lock': '' }))).toBe('bun');
    expect(runScript('npm', 'start')).toBe('npm start');
    expect(runScript('npm', 'tauri dev')).toBe('npm run tauri dev');
    expect(runScript('bun', 'dev')).toBe('bun run dev');
  });
});

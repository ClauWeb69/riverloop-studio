// Differenze tra sistemi nei test end-to-end: chiusura ordinata di Studio ed elenco dei processi.
import { execSync } from 'node:child_process';
import http from 'node:http';

export const windows = process.platform === 'win32';

/**
 * Chiusura ordinata di riverloop-studio. Su Unix è Ctrl+C (SIGINT). Su Windows a un processo
 * figlio non si può inviare Ctrl+C (kill lo terminerebbe di colpo, lasciando dev server e
 * claude orfani): si chiede la stessa chiusura all'API, con il token del link di Studio.
 */
export async function stopStudio(proc, studioUrl) {
  const m = windows ? /127\.0\.0\.1:(\d+)\/#t=([0-9a-f]{64})/.exec(studioUrl ?? '') : null;
  if (!m) {
    proc.kill('SIGINT');
    return;
  }
  await new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(m[1]),
        path: '/api/shutdown',
        method: 'POST',
        headers: { 'X-Studio-Token': m[2], Origin: `http://127.0.0.1:${m[1]}`, 'Content-Type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', resolve);
    req.end('{}');
  });
}

/** Righe "pid riga di comando" di tutti i processi. */
export function processLines() {
  if (!windows) return execSync('ps -eo pid=,args=').toString().split('\n');
  const json = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"', {
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
  return JSON.parse(json).map((p) => `${p.ProcessId} ${p.CommandLine ?? ''}`);
}

/** Il processo esiste ancora (su Unix uno zombie, già terminato, conta come chiuso). */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (windows) return true;
  try {
    return !execSync(`ps -o stat= -p ${pid}`).toString().trim().startsWith('Z');
  } catch {
    return false;
  }
}

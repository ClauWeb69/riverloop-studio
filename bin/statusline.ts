#!/usr/bin/env node
// Status line di Claude Code usata da Riverloop Studio: Claude Code la esegue a ogni cambiamento
// passandole su stdin un JSON con modello, effort, utilizzo del piano e contesto. Lo script ne
// manda l'essenziale al companion (per la barra di Claude nella pagina) e, se l'utente ha una
// sua status line, la esegue con gli stessi dati e ne stampa l'output: per l'utente non cambia
// niente. Non deve mai bloccare Claude: esce comunque entro pochi secondi, sempre con 0.
import { spawn } from 'node:child_process';
import http from 'node:http';

const url = process.env.RIVERLOOP_STUDIO_HOOK_URL;
const token = process.env.RIVERLOOP_STUDIO_HOOK_TOKEN;
const session = process.env.RIVERLOOP_STUDIO_SESSION || '1';
const userCommand = process.env.RIVERLOOP_STUDIO_USER_STATUSLINE;

setTimeout(() => process.exit(0), 4500).unref();

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

/** Solo i campi che servono alla pagina (il JSON completo contiene percorsi e altro). */
function essentials(data: Json): Json {
  const model = obj(data.model);
  const limits = obj(data.rate_limits);
  const windowOf = (w: unknown) => {
    const o = obj(w);
    return { used_percentage: o.used_percentage, resets_at: o.resets_at };
  };
  return {
    model: { id: model.id, display_name: model.display_name },
    effort: { level: obj(data.effort).level },
    rate_limits: { five_hour: windowOf(limits.five_hour), seven_day: windowOf(limits.seven_day) },
    context_window: { used_percentage: obj(data.context_window).used_percentage },
    cost: { total_cost_usd: obj(data.cost).total_cost_usd },
  };
}

function report(data: Json): Promise<void> {
  if (!url || !token) return Promise.resolve();
  const body = JSON.stringify({ event: 'status', session, status: essentials(data) });
  return new Promise((resolve) => {
    try {
      const target = new URL(url);
      const req = http.request(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Studio-Hook': token },
          timeout: 2000,
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve());
      req.end(body);
    } catch {
      resolve();
    }
  });
}

/** Esegue la status line dell'utente con lo stesso input e ne restituisce l'output. */
function runUserStatusLine(input: string): Promise<string> {
  if (!userCommand) return Promise.resolve('');
  return new Promise((resolve) => {
    let out = '';
    try {
      const child = spawn(userCommand, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const timer = setTimeout(() => child.kill(), 4000);
      child.stdout.on('data', (d: Buffer) => {
        if (out.length < 64 * 1024) out += d.toString('utf8');
      });
      child.on('error', () => resolve(out));
      child.on('close', () => {
        clearTimeout(timer);
        resolve(out);
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    } catch {
      resolve(out);
    }
  });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  if (input.length < 1_000_000) input += chunk;
});
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  let data: Json = {};
  try {
    data = obj(JSON.parse(input));
  } catch {
    /* stdin vuoto o non JSON */
  }
  void Promise.all([report(data), runUserStatusLine(input)]).then(([, out]) => {
    if (out) process.stdout.write(out);
    process.exit(0);
  });
});

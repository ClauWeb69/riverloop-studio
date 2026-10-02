#!/usr/bin/env node
// Hook di Claude Code usato da Riverloop Studio nelle modalità desktop: avvisa il companion
// che uno strumento ha modificato il progetto (PostToolUse) o che la risposta è finita (Stop).
// Claude Code passa i dati dell'evento in JSON su stdin. Non scrive nulla ed esce sempre con 0:
// un hook non deve mai rallentare o bloccare Claude.
import http from 'node:http';

const url = process.env.RIVERLOOP_STUDIO_HOOK_URL;
const token = process.env.RIVERLOOP_STUDIO_HOOK_TOKEN;
const session = process.env.RIVERLOOP_STUDIO_SESSION || '1';

function done(): void {
  process.exit(0);
}

if (!url || !token) done();
setTimeout(done, 3000).unref();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  if (input.length < 1_000_000) input += chunk;
});
process.stdin.on('error', done);
process.stdin.on('end', () => {
  let event = '';
  try {
    event = String((JSON.parse(input) as { hook_event_name?: unknown }).hook_event_name ?? '');
  } catch {
    /* stdin vuoto o non JSON */
  }
  if (event !== 'Stop' && event !== 'PostToolUse') return done();
  const body = JSON.stringify({ event, session });
  try {
    const target = new URL(url as string);
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Studio-Hook': token as string },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        res.on('end', done);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', done);
    req.end(body);
  } catch {
    done();
  }
});

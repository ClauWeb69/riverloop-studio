#!/usr/bin/env node
// Finto "claude" per i test: registra tutto l'input ricevuto dal PTY in FAKE_CLAUDE_LOG.
// Imita il riquadro di input di Claude Code (linee orizzontali, "[Pasted text #N +M lines]").
// Con FAKE_CLAUDE_PASTE_DELAY_MS imita anche un Claude Code lento: un Invio che arriva entro
// quel tempo dall'incolla viene assorbito nel testo incollato invece di inviare il messaggio.
// Con FAKE_CLAUDE_DIALOG=1, dopo l'invio di un messaggio di Studio apre una richiesta di
// permesso come quella di Claude Code 2.1: un Invio in quel momento la approverebbe.
// Come Claude Code, esegue gli hook del file passato con --settings: a ogni messaggio inviato
// lancia gli hook PostToolUse (se il messaggio contiene "MODIFICA", come se avesse scritto un
// file) e poi gli hook Stop, passando i dati dell'evento in JSON su stdin.
// Imita anche la status line (comando di statusLine nel file di --settings, con un JSON di
// modello, effort e utilizzo), Shift+Tab che scorre le modalità (testo in fondo allo schermo
// come Claude Code 2.1.28x), l'indicatore dell'effort sopra il riquadro ("◉ medium · /effort",
// con "· ultracode" e l'etichetta sulla linea di sopra quando è attivo, come Claude Code 2.1.287)
// e i comandi /model, /effort (anche "/effort ultracode on|off"), /goal e /usage.
// Con FAKE_CLAUDE_NO_ULTRACODE=1 rifiuta "/effort ultracode on" e l'indicatore resta senza ultracode.
import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

if (process.argv.includes('--version')) {
  console.log('9.9.9 (Fake Claude)');
  process.exit(0);
}

const logFile = process.env.FAKE_CLAUDE_LOG;
const pasteDelay = Number(process.env.FAKE_CLAUDE_PASTE_DELAY_MS || 0);
const withDialog = process.env.FAKE_CLAUDE_DIALOG === '1';
const noUltracode = process.env.FAKE_CLAUDE_NO_ULTRACODE === '1';
const record = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...entry })}\n`);
};

// Come Claude Code 2.1: la conversazione in corso è in <CLAUDE_CONFIG_DIR>/sessions/<pid>.json
const argv = process.argv.slice(2);
const resumeAt = argv.indexOf('--resume');
const resumed = resumeAt >= 0 && /^[0-9a-f-]{36}$/i.test(argv[resumeAt + 1] || '') ? argv[resumeAt + 1] : null;
const conversation = resumed ?? randomUUID();
const sessionsDir = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions') : null;
if (sessionsDir) {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(path.join(sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: conversation, cwd: process.cwd() }));
  process.on('exit', () => rmSync(path.join(sessionsDir, `${process.pid}.json`), { force: true }));
}
record({ event: 'start', pid: process.pid, argv, conversation, cols: process.stdout.columns, rows: process.stdout.rows, cwd: process.cwd() });
process.stdout.write('\x1b[?2004h');
// Con FAKE_CLAUDE_DEMO=1 (screenshot della documentazione) la console ha l'aria di una sessione
// vera, ma si dichiara come dimostrativa; le risposte sono testi fissi.
const demo = process.env.FAKE_CLAUDE_DEMO === '1';
/** Righe della conversazione dimostrativa, ridisegnate a ogni aggiornamento dello schermo. */
const demoTranscript = [];
if (demo) {
  demoTranscript.push('\x1b[2m  Claude Code · demo session (simulated replies)\x1b[0m', '');
} else {
  process.stdout.write(
    `\x1b[1;35m◆ Fake Claude\x1b[0m argv=${JSON.stringify(process.argv.slice(2))} size=${process.stdout.columns}x${process.stdout.rows}\r\n`,
  );
}
/** Risposta dimostrativa a una richiesta di Studio (solo con FAKE_CLAUDE_DEMO=1). */
function demoReply(message) {
  const items = (message.match(/^\d+\. /gm) ?? []).length || 1;
  return [
    `\x1b[2m> Requested changes (${items} annotation${items > 1 ? 's' : ''}, with screenshots)\x1b[0m`,
    '',
    `\x1b[1m●\x1b[0m I'll apply the ${items} requested change${items > 1 ? 's' : ''} in \x1b[1mapp/demo/page.tsx\x1b[0m.`,
    '',
    '\x1b[1m●\x1b[0m \x1b[1mUpdate\x1b[0m(app/demo/page.tsx)',
    '  └  Updated app/demo/page.tsx with 6 additions and 4 removals',
    '',
    '\x1b[1m●\x1b[0m Done: smaller heading aligned with the cards,',
    '  gradient bars, and a friendlier subtitle with the date.',
    '',
  ];
}

process.stdout.on('resize', () => {
  record({ event: 'resize', cols: process.stdout.columns, rows: process.stdout.rows });
  // La console dimostrativa si ridisegna alla nuova larghezza, come Claude Code
  if (process.env.FAKE_CLAUDE_DEMO === '1') setImmediate(() => drawBox());
});

// Hook e status line dichiarati nel file di impostazioni (--settings <file>), come li legge Claude Code
let hooks = {};
let statusCommand = null;
const settingsAt = argv.indexOf('--settings');
if (settingsAt >= 0 && argv[settingsAt + 1]) {
  try {
    const settings = JSON.parse(readFileSync(argv[settingsAt + 1], 'utf8'));
    hooks = settings.hooks ?? {};
    statusCommand = settings.statusLine?.type === 'command' ? settings.statusLine.command : null;
  } catch (err) {
    record({ event: 'settings-error', message: String(err.message) });
  }
}

// Stato mostrato nella status line e in fondo allo schermo
const MODES = [
  ['default', '⏸ manual mode on · ? for shortcuts'],
  ['acceptEdits', '⏵⏵ accept edits on (shift+tab to cycle)'],
  ['plan', '⏸ plan mode on (shift+tab to cycle)'],
  ['auto', '⏵⏵ auto mode on (shift+tab to cycle)'],
  ...(argv.includes('--dangerously-skip-permissions') ? [['bypassPermissions', '⏵⏵ bypass permissions on (shift+tab to cycle)']] : []),
];
let modeIndex = 0;
let model = demo ? { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } : { id: 'claude-fake-1', display_name: 'Fake Opus' };
let effort = demo ? 'high' : 'medium';
// Ultracode: come in Claude Code 2.1.287 non compare nel JSON della status line, solo sullo schermo
let ultracode = false;
function runStatusLine() {
  if (!statusCommand) return;
  const now = Math.floor(Date.now() / 1000);
  const data = {
    session_id: conversation,
    model,
    effort: { level: effort },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: now + 3600 }, seven_day: { used_percentage: 34, resets_at: now + 86400 * 3 } },
    context_window: { used_percentage: 5, context_window_size: 200000 },
    cost: { total_cost_usd: 0 },
  };
  const child = exec(statusCommand, { windowsHide: true }, (error) => record({ event: 'statusline', ok: !error }));
  child.stdin.end(JSON.stringify(data));
}
/** Comandi di Claude Code imitati: restituisce il testo da mostrare, o null se non è un comando. */
function slashCommand(text) {
  const m = /^\/(model|effort|goal|usage)\b\s*(.*)$/.exec(text.trim());
  if (!m) return null;
  record({ event: 'command', name: m[1], arg: m[2] });
  if (m[1] === 'model') {
    const alias = m[2] || 'default';
    model = { id: `claude-${alias}-fake`, display_name: `Fake ${alias[0].toUpperCase()}${alias.slice(1)}` };
    return `Set model to ${model.display_name} and saved as your default for new sessions`;
  }
  if (m[1] === 'effort') {
    const ultra = /^ultracode\s+(on|off)$/.exec(m[2]);
    if (ultra) {
      // Con FAKE_CLAUDE_NO_ULTRACODE=1 rifiuta l'attivazione, come per un modello o piano senza ultracode
      if (noUltracode && ultra[1] === 'on') return 'Ultracode is not available for your current model or plan.';
      // Solo per la sessione: il livello resta quello di prima
      ultracode = ultra[1] === 'on';
      return ultracode
        ? `Ultracode on (this session only): dynamic workflows on every task. Effort stays ${effort}.`
        : `Ultracode off. Effort stays ${effort}.`;
    }
    effort = m[2] === 'auto' ? 'medium' : m[2];
    return `Set effort level to ${m[2]}`;
  }
  if (m[1] === 'goal') return m[2] === 'clear' ? 'Goal cleared' : `Goal set: ${m[2]}`;
  return 'Usage: 12% of 5-hour limit';
}
function runHooks(event, tool) {
  const commands = (hooks[event] ?? [])
    .filter((entry) => !entry.matcher || !tool || new RegExp(`^(?:${entry.matcher})$`).test(tool))
    .flatMap((entry) => (entry.hooks ?? []).map((h) => h.command));
  return Promise.all(
    commands.map(
      (command) =>
        new Promise((resolve) => {
          const child = exec(command, { windowsHide: true }, (error) => {
            record({ event: 'hook', hook: event, ok: !error });
            resolve();
          });
          child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: conversation, cwd: process.cwd(), ...(tool ? { tool_name: tool } : {}) }));
        }),
    ),
  );
}
async function finishTurn(message) {
  if (message.includes('MODIFICA')) await runHooks('PostToolUse', 'Edit');
  await runHooks('Stop');
}

let line = '';
let pastes = 0;
let pasteUntil = 0;
let pasted = false;
let dialogOpen = false;

const width = () => Math.min(60, (process.stdout.columns || 80) - 2);
const rule = () => '─'.repeat(width());
function drawBox() {
  const content = pasted ? `[Pasted text #${pastes} +${line.split('\n').length - 1} lines]` : line.replace(/\n/g, ' ⏎ ');
  // Indicatore dell'effort allineato a destra sopra il riquadro; con ultracode anche l'etichetta sulla linea di sopra
  const indicator = `◉ ${effort}${ultracode ? ' · ultracode' : ''} · /effort`;
  const top = ultracode ? `${'─'.repeat(width() - 12)} ultracode ─` : rule();
  const pad = ' '.repeat(Math.max(4, width() - indicator.length));
  // Come Claude Code: spazio non separabile dopo il cursore ❯
  if (demo) process.stdout.write(`\x1b[H\x1b[2J${demoTranscript.join('\r\n')}`);
  process.stdout.write(`\r\n${pad}${indicator}\r\n${top}\r\n❯\u00a0${content}\r\n${rule()}\r\n  ${MODES[modeIndex][1]}\r\n`);
}
function drawDialog(firstLine) {
  // La richiesta mostra apposta la prima riga del messaggio: non deve ingannare l'invio automatico.
  const dashed = '╌'.repeat(width());
  process.stdout.write(
    `\r\n● Scrive un file di prova\r\n\r\n${rule()}\r\n Bash command\r\n Scrive un file di prova\r\n${dashed}\r\n` +
      ` echo "${firstLine.slice(0, 40)}"\r\n${dashed}\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n\r\n Esc to cancel · Tab to amend\r\n`,
  );
}
drawBox();
runStatusLine();

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
// Un incolla può arrivare a pezzi (su Windows ConPTY consegna l'input in più blocchi): come
// Claude Code, lo si considera finito solo al marcatore di chiusura.
let pasteBuffer = null;
process.stdin.on('data', (data) => {
  record({ event: 'input', data });
  if (data.includes('\x04')) {
    process.stdout.write('\r\nbye\r\n');
    process.exit(3);
  }
  // Come Claude Code: dentro un bracketed paste gli a capo (\r) inseriscono una nuova riga.
  let text = data;
  let pasteText = '';
  const START = '\x1b[200~';
  const END = '\x1b[201~';
  const finishPaste = (raw) => {
    record({ event: 'paste', raw });
    pasteText = raw.replace(/\r/g, '\n');
  };
  if (pasteBuffer !== null) {
    const end = text.indexOf(END);
    if (end < 0) {
      pasteBuffer += text;
      return;
    }
    finishPaste(pasteBuffer + text.slice(0, end));
    pasteBuffer = null;
    text = '\u0000' + text.slice(end + END.length);
  } else {
    const start = text.indexOf(START);
    if (start >= 0) {
      const end = text.indexOf(END, start);
      if (end < 0) {
        // Il resto dell'incolla arriva con i prossimi blocchi
        pasteBuffer = text.slice(start + START.length);
        text = text.slice(0, start);
      } else {
        finishPaste(text.slice(start + START.length, end));
        text = text.slice(0, start) + '\u0000' + text.slice(end + END.length);
      }
    }
  }
  if (dialogOpen) {
    // Richiesta di permesso aperta: Invio = "1. Yes", Esc = annulla
    if (data.includes('\r')) {
      record({ event: 'approved' });
      dialogOpen = false;
      process.stdout.write('\r\n\x1b[31m✗ permesso approvato\x1b[0m');
      drawBox();
    } else if (data.startsWith('\x1b') && !data.startsWith('\x1b[')) {
      record({ event: 'dialog-cancelled' });
      dialogOpen = false;
      drawBox();
    }
    return;
  }
  // Shift+Tab (ESC [ Z): modalità successiva, come Claude Code
  if (text.includes('\x1b[Z')) {
    const presses = text.split('\x1b[Z').length - 1;
    modeIndex = (modeIndex + presses) % MODES.length;
    record({ event: 'mode', mode: MODES[modeIndex][0] });
    text = text.split('\x1b[Z').join('');
    drawBox();
    runStatusLine();
    if (!text) return;
  }
  let changed = false;
  for (const ch of text) {
    if (ch === '\u0000') {
      line += pasteText;
      pastes++;
      pasted = true;
      pasteUntil = Date.now() + pasteDelay;
      changed = true;
      continue;
    }
    if (ch === '\r') {
      if (pasted && Date.now() < pasteUntil) {
        // Invio arrivato mentre l'incolla è ancora "in elaborazione": diventa un a capo.
        line += '\n';
        record({ event: 'absorbed-enter' });
        changed = true;
        continue;
      }
      record({ event: 'submit', line });
      if (demo) demoTranscript.push(...demoReply(line));
      else process.stdout.write(`\r\n\x1b[32m✓ ricevuto (${line.length} caratteri)\x1b[0m`);
      const submitted = line;
      line = '';
      pasted = false;
      const reply = slashCommand(submitted);
      if (reply !== null) {
        process.stdout.write(`\r\n  ⎿  ${reply}`);
        drawBox();
        runStatusLine();
        return;
      }
      if (withDialog && submitted.startsWith('Modifiche richieste')) {
        dialogOpen = true;
        drawDialog(submitted.split('\n')[0]);
        return;
      }
      void finishTurn(submitted).then(runStatusLine);
      changed = true;
    } else if (ch === '\x7f') {
      line = line.slice(0, -1);
      changed = true;
    } else if (ch === '\x1b') {
      // ESC (es. Alt+Invio = ESC CR): il CR che segue va a capo
      line += '\n';
      changed = true;
      break;
    } else if (ch >= ' ' || ch === '\n') {
      line += ch;
      changed = true;
    }
  }
  if (changed) drawBox();
});

for (const sig of ['SIGHUP', 'SIGTERM']) {
  process.on(sig, () => {
    record({ event: 'signal', sig });
    process.exit(0);
  });
}

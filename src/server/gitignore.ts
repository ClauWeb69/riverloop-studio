import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { t } from './i18n.js';
import { readProjectState, updateProjectState } from './state.js';
import { c, log } from './util.js';

const ENTRY = '.claude/studio/';

type IgnoreStatus = 'ignored' | 'not-ignored' | 'no-git';

function findGitRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function patternsIgnore(cwd: string): boolean {
  const file = path.join(cwd, '.gitignore');
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return lines.some((l) => /^\/?\.claude(\/|\/studio\/?|\/\*\*?)?$/.test(l) || /^\/?\.claude\/studio(\/\*\*?)?\/?$/.test(l));
}

export function gitIgnoreStatus(cwd: string): IgnoreStatus {
  if (!findGitRoot(cwd)) return 'no-git';
  const res = spawnSync('git', ['check-ignore', '-q', `${ENTRY}annotations/prova.png`], {
    cwd,
    timeout: 4000,
    windowsHide: true,
    stdio: 'ignore',
  });
  if (res.status === 0) return 'ignored';
  if (res.status === 1) return 'not-ignored';
  // git non disponibile: controllo manuale del .gitignore
  return patternsIgnore(cwd) ? 'ignored' : 'not-ignored';
}

export async function addToGitignore(cwd: string): Promise<void> {
  const file = path.join(cwd, '.gitignore');
  let prefix = '';
  if (existsSync(file)) {
    const current = await readFile(file, 'utf8');
    if (current.length && !current.endsWith('\n')) prefix = '\n';
  }
  await appendFile(file, `${prefix}\n${t('gitignore.comment')}\n${ENTRY}\n`, 'utf8');
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => {
      rl.close();
      process.stdout.write('\n');
      process.exit(130);
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Al primo avvio propone di aggiungere .claude/studio/ al .gitignore del progetto. */
export async function proposeGitignore(cwd: string): Promise<void> {
  if (gitIgnoreStatus(cwd) !== 'not-ignored') return;
  const state = await readProjectState(cwd);
  if (state.gitignoreDeclined) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log.warn(t('gitignore.addHint', { entry: c.bold(ENTRY) }));
    return;
  }
  const answer = (await ask(`${c.brand('?')} ${t('gitignore.ask', { entry: c.bold(ENTRY) })} ${c.dim(t('gitignore.askChoices'))} `)).trim().toLowerCase();
  // S (sì) o Y (yes), in qualunque lingua
  if (answer === '' || answer.startsWith('s') || answer.startsWith('y')) {
    await addToGitignore(cwd);
    log.ok(t('gitignore.added', { entry: ENTRY }));
  } else {
    await updateProjectState(cwd, { gitignoreDeclined: true });
    log.dim(t('gitignore.declined'));
  }
}

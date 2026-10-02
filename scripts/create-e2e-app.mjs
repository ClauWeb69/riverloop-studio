#!/usr/bin/env node
// Crea l'app Next.js usata dal test end-to-end della modalità web (test/e2e/run.mjs):
// il modello predefinito di create-next-app, con la versione di Next fissata perché il test
// cerca il testo della pagina iniziale ("To get started, edit the").
//
// Uso: node scripts/create-e2e-app.mjs [cartella]   (predefinita: ../riverloop-e2e-app)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const NEXT_VERSION = '16';
const dir = path.resolve(process.argv[2] ?? path.join(process.cwd(), '..', 'riverloop-e2e-app'));

if (existsSync(path.join(dir, 'package.json'))) {
  console.log(`Already there: ${dir}`);
} else {
  const args = [
    '--yes',
    `create-next-app@${NEXT_VERSION}`,
    dir,
    '--ts',
    '--tailwind',
    '--app',
    '--no-eslint',
    '--no-src-dir',
    '--use-npm',
    '--disable-git',
    '--import-alias',
    '@/*',
    '--yes',
  ];
  console.log(`npx ${args.join(' ')}`);
  // Su Windows npx è uno script .cmd e va avviato da una shell: un'unica riga con gli argomenti tra virgolette
  const res =
    process.platform === 'win32'
      ? spawnSync(['npx', ...args.map((a) => `"${a}"`)].join(' '), { stdio: 'inherit', shell: true })
      : spawnSync('npx', args, { stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const page = ['app/page.tsx', 'src/app/page.tsx'].map((p) => path.join(dir, p)).find(existsSync);
if (!page || !readFileSync(page, 'utf8').includes('To get started, edit the')) {
  console.error(
    `The starter page in ${dir} does not contain "To get started, edit the": the e2e test needs the default create-next-app ${NEXT_VERSION} template.`,
  );
  process.exit(1);
}
console.log(`\nReady. Run the web e2e test with:\n  npm run test:e2e -- --app "${dir}"`);

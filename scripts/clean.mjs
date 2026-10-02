// Rimuove la build del server prima di ricompilare (multipiattaforma, senza dipendenze).
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const dir of ['../dist/bin', '../dist/src']) {
  rmSync(fileURLToPath(new URL(dir, import.meta.url)), { recursive: true, force: true });
}

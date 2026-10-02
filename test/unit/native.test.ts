import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { composePrompt } from '../../src/server/annotations.js';
import { findNativeSource, sourcePatterns } from '../../src/server/nativeSource.js';
import type { AnnotationData, NativeElement } from '../../src/shared/protocol.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-native-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const native = (partial: Partial<NativeElement> = {}): NativeElement => ({
  role: 'Button',
  name: 'Salva',
  automationId: 'btnSalva',
  className: 'WindowsForms10.BUTTON',
  framework: 'WinForm',
  path: ['Window «Clienti»'],
  rect: { x: 10, y: 10, width: 80, height: 24 },
  ...partial,
});

const project = path.join(tmp, 'app');

describe('sorgente probabile di un controllo nativo', () => {
  mkdirSync(path.join(project, 'src'), { recursive: true });
  mkdirSync(path.join(project, 'bin', 'Debug'), { recursive: true });
  mkdirSync(path.join(project, 'node_modules', 'x'), { recursive: true });
  writeFileSync(
    path.join(project, 'src', 'Form1.Designer.cs'),
    'namespace App {\n  partial class Form1 {\n    this.btnSalva = new Button();\n    this.btnSalva.Text = "Salva";\n  }\n}\n',
  );
  writeFileSync(path.join(project, 'src', 'Main.xaml'), '<Window>\n  <Button Content="Annulla" />\n</Window>\n');
  // cartelle di build e dipendenze: non si guardano
  writeFileSync(path.join(project, 'bin', 'Debug', 'copia.cs'), 'btnSalva\n');
  writeFileSync(path.join(project, 'node_modules', 'x', 'index.js'), 'btnSalva\n');

  it("trova l'AutomationId come parola intera, con file e riga", async () => {
    expect(await findNativeSource(project, native())).toEqual([
      { file: 'src/Form1.Designer.cs', line: 3 },
      { file: 'src/Form1.Designer.cs', line: 4 },
    ]);
  });

  it('senza AutomationId utile cerca il testo tra virgolette', async () => {
    expect(await findNativeSource(project, native({ automationId: '', name: 'Annulla' }))).toEqual([{ file: 'src/Main.xaml', line: 2 }]);
    expect(await findNativeSource(project, native({ automationId: 'Close', name: 'Chiudi' }))).toEqual([]);
  });

  it('ignora identificativi generici o numerici e testi troppo lunghi', () => {
    expect(sourcePatterns({ automationId: '1001', name: '' })).toEqual([]);
    expect(sourcePatterns({ automationId: 'Minimize', name: 'x' })).toEqual([]);
    expect(sourcePatterns({ automationId: 'txt.Nome', name: 'a'.repeat(80) })).toHaveLength(1);
  });
});

describe('messaggio per Claude sulle finestre native', () => {
  it('riporta i controlli contenuti in una zona e la sorgente probabile', () => {
    const a: AnnotationData = {
      id: 1,
      kind: 'area',
      comment: 'allinea questi campi',
      url: 'Clienti',
      title: 'Clienti',
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, dpr: 1 },
      selector: null,
      label: null,
      html: null,
      text: null,
      styles: null,
      rect: { x: 10, y: 10, width: 300, height: 120 },
      viewportRect: { x: 10, y: 10, width: 300, height: 120 },
      anchor: { selector: null, offsetX: 10, offsetY: 10 },
      screenshot: null,
      surface: 'window',
      native: native(),
      contains: [
        { label: 'Edit «Nome»', selector: 'txtNome' },
        { label: 'Button «Salva»', selector: '' },
      ],
      sources: ['src/Form1.Designer.cs:3'],
    };
    const prompt = composePrompt({ annotations: [a], screenshots: new Map([[1, null]]), jsonPath: 'x.json' }, project);
    expect(prompt).toContain('`Edit «Nome»` (AutomationId `txtNome`), `Button «Salva»`');
    expect(prompt).toContain('`src/Form1.Designer.cs:3`');
  });
});

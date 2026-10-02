import { createRequire } from 'node:module';
import path from 'node:path';
import { transformSync } from '@babel/core';
import { describe, expect, it } from 'vitest';
import { isHostTag, sourcePath, sourceTaggingDisabled, tagSource, usesForeignRenderer } from '../../src/plugin/transform.cjs';
import studioVite from '../../src/plugin/vite.js';

const require = createRequire(import.meta.url);
const root = path.resolve('/progetti/app');
const file = path.join(root, 'src', 'components', 'Hero.tsx');

describe('fase 3: file e riga degli elementi (data-studio-src)', () => {
  it('marca gli elementi host con percorso relativo, riga e colonna', () => {
    const code = [
      'export function Hero({ title }: { title: string }) {',
      '  return (',
      '    <section className="hero">',
      '      <h1>{title}</h1>',
      '    </section>',
      '  );',
      '}',
    ].join('\n');
    const out = tagSource(code, file, { root });
    expect(out?.count).toBe(2);
    expect(out?.code).toContain('<section data-studio-src="src/components/Hero.tsx:3:5" className="hero">');
    expect(out?.code).toContain('<h1 data-studio-src="src/components/Hero.tsx:4:7">{title}</h1>');
    // le righe non cambiano: gli errori del compilatore restano sulle righe giuste
    expect(out?.code.split('\n')).toHaveLength(code.split('\n').length);
    expect(out?.map.sources[0]).toContain('Hero.tsx');
  });

  it('lascia stare componenti, frammenti e membri (a.b)', () => {
    const code = 'const x = <><Card title="a"><motion.div><p>ciao</p></motion.div></Card><my-widget /></>;';
    const out = tagSource(code, file, { root });
    expect(out?.code).toContain('<Card title="a">');
    expect(out?.code).toContain('<motion.div>');
    expect(out?.code).toContain('<p data-studio-src=');
    expect(out?.code).toContain('<my-widget data-studio-src="src/components/Hero.tsx:1:72" />');
    expect(out?.count).toBe(2);
  });

  it('non duplica un attributo già presente e non tocca i file senza JSX', () => {
    expect(tagSource('const a = <div data-studio-src="x.tsx:1:1" />;', file, { root })).toBeNull();
    expect(tagSource('export const n = 1 < 2 ? "a" : "b";', file, { root })).toBeNull();
    expect(tagSource('const s = "<div>non è JSX</div>";', file, { root })).toBeNull();
  });

  it('capisce TypeScript e JavaScript, e non lancia sui file che non sa leggere', () => {
    const ts = 'const C = <T,>(p: { v: T }) => <span>{String(p.v as unknown)}</span>;\nenum E { A }\n';
    expect(tagSource(ts, file, { root })?.code).toContain('<span data-studio-src="src/components/Hero.tsx:1:32">');
    const js = 'export default function A() { return <ul>{[1].map((i) => <li key={i}>{i}</li>)}</ul>; }';
    expect(tagSource(js, path.join(root, 'A.jsx'), { root })?.count).toBe(2);
    expect(tagSource('const = <div', file, { root })).toBeNull();
  });

  it('usa percorsi con le barre "/" e assoluti fuori dalla radice', () => {
    expect(sourcePath(path.join(root, 'app', 'page.tsx'), root)).toBe('app/page.tsx');
    expect(sourcePath(`${path.join(root, 'app', 'page.tsx')}?v=123`, root)).toBe('app/page.tsx');
    const outside = path.resolve('/altrove/x.tsx');
    expect(sourcePath(outside, root)).toBe(outside.replace(/\\/g, '/'));
    expect(isHostTag('div')).toBe(true);
    expect(isHostTag('my-widget')).toBe(true);
    expect(isHostTag('Card')).toBe(false);
  });

  it("non tocca i tag di altri renderer (React Three Fiber): lì un attributo in più rompe l'app", () => {
    // nomi minuscoli che non sono elementi HTML o SVG
    for (const tag of ['mesh', 'boxGeometry', 'meshStandardMaterial', 'ambientLight', 'group', 'primitive']) expect(isHostTag(tag)).toBe(false);
    for (const tag of ['svg', 'path', 'linearGradient', 'foreignObject', 'video', 'dialog']) expect(isHostTag(tag)).toBe(true);
    const scene = 'export const Box = () => <mesh><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color="hotpink" /></mesh>;';
    expect(tagSource(scene, file, { root })).toBeNull();
    // un file del renderer resta com'è anche dove usa nomi che esistono in HTML e SVG
    const mixed = "import { Canvas } from '@react-three/fiber';\nexport const Scene = () => <Canvas><line /><audio /></Canvas>;";
    expect(usesForeignRenderer(mixed)).toBe(true);
    expect(tagSource(mixed, file, { root })).toBeNull();
    expect(usesForeignRenderer("import React from 'react';")).toBe(false);
  });

  it('i plugin restano spenti in produzione e sotto i test del progetto', () => {
    expect(sourceTaggingDisabled({ NODE_ENV: 'development' })).toBe(false);
    expect(sourceTaggingDisabled({})).toBe(false);
    expect(sourceTaggingDisabled({ NODE_ENV: 'production' })).toBe(true);
    expect(sourceTaggingDisabled({ NODE_ENV: 'test' })).toBe(true);
    expect(sourceTaggingDisabled({ NODE_ENV: 'development', VITEST: 'true' })).toBe(true);
    expect(sourceTaggingDisabled({ JEST_WORKER_ID: '1' })).toBe(true);
    // questi test girano con Vitest: senza "always" il plugin di Vite non fa nulla
    const off = studioVite();
    (off.configResolved as (c: { root: string }) => void)({ root });
    expect((off.transform as (code: string, id: string) => unknown)('export const A = () => <div />;', file)).toBeNull();
  });

  it('plugin di Vite: solo dev server, prima degli altri, solo .jsx/.tsx del progetto', () => {
    const plugin = studioVite({ always: true });
    expect(plugin.enforce).toBe('pre');
    expect(plugin.apply).toBe('serve');
    (plugin.configResolved as (c: { root: string }) => void)({ root });
    const run = plugin.transform as (code: string, id: string) => { code: string } | null;
    expect(run('export const A = () => <div />;', `${file}?t=1`)?.code).toContain('data-studio-src="src/components/Hero.tsx:1:24"');
    expect(run('export const A = () => <div />;', path.join(root, 'node_modules', 'x', 'a.tsx'))).toBeNull();
    expect(run('export const a = 1;', path.join(root, 'src', 'a.ts'))).toBeNull();
  });

  it('plugin di Babel: stesso attributo, niente in produzione', () => {
    const babelPlugin = require.resolve('../../dist/src/plugin/babel.cjs');
    const run = (env: string, options: { always?: boolean } = {}) => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = env;
      try {
        return transformSync('const a = <div><Card /></div>;', {
          filename: file,
          cwd: root,
          babelrc: false,
          configFile: false,
          parserOpts: { plugins: ['jsx', 'typescript'] },
          plugins: [[babelPlugin, options]],
        })?.code;
      } finally {
        process.env.NODE_ENV = previous;
      }
    };
    // (sotto Vitest serve "always": altrimenti il plugin resta spento, come nei test di un progetto)
    expect(run('development', { always: true })).toContain('<div data-studio-src="src/components/Hero.tsx:1:11">');
    expect(run('development', { always: true })).toContain('<Card />');
    expect(run('development')).not.toContain('data-studio-src');
    expect(run('production')).not.toContain('data-studio-src');
  });
});

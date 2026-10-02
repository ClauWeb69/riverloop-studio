// Plugin per Babel: file e riga esatti di ogni elemento JSX (attributo data-studio-src).
//
//   // babel.config.js / .babelrc
//   { "plugins": ["riverloop-studio/babel"] }
//
// Con @vitejs/plugin-react: react({ babel: { plugins: ['riverloop-studio/babel'] } }).
// Nelle build di produzione e sotto i test (NODE_ENV=production o test) non fa nulla, a meno di { always: true }.
import type { PluginObj, PluginPass, types as BabelTypes } from '@babel/core';
import { isHostTag, SOURCE_ATTRIBUTE, sourcePath, sourceTaggingDisabled, usesForeignRenderer } from './transform.cjs';

interface StudioBabelOptions {
  root?: string;
  attribute?: string;
  always?: boolean;
}

function riverloopStudioBabel(api: { types: typeof BabelTypes }): PluginObj<PluginPass> {
  const t = api.types;
  return {
    name: 'riverloop-studio-source',
    visitor: {
      JSXOpeningElement(nodePath, state) {
        const opts = (state.opts ?? {}) as StudioBabelOptions;
        if (sourceTaggingDisabled() && !opts.always) return;
        if (usesForeignRenderer(state.file?.code ?? '')) return;
        const node = nodePath.node;
        if (!t.isJSXIdentifier(node.name) || !isHostTag(node.name.name) || !node.loc) return;
        const attribute = opts.attribute || SOURCE_ATTRIBUTE;
        if (node.attributes.some((a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === attribute)) return;
        const filename = state.filename || state.file?.opts?.filename;
        if (!filename || /[\\/]node_modules[\\/]/.test(filename)) return;
        const root = opts.root || state.cwd || process.cwd();
        const value = `${sourcePath(filename, root)}:${node.loc.start.line}:${node.loc.start.column + 1}`;
        node.attributes.push(t.jsxAttribute(t.jsxIdentifier(attribute), t.stringLiteral(value)));
      },
    },
  };
}

export = riverloopStudioBabel;

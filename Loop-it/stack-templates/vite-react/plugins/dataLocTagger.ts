/**
 * Dev-only Vite plugin: stamp JSX/TSX elements with data-loc="file:line:col"
 * so the preview inspector can map clicks back to source (Phase 2.1 / Lovable-style).
 */
import type { Plugin } from 'vite';
import path from 'node:path';

const JSX_OPEN = /<(?!\/)([A-Za-z][\w.-]*)(\s[^>]*?)?(\/)?>/g;

export function dataLocTagger(): Plugin {
  return {
    name: 'loopit-data-loc-tagger',
    apply: 'serve',
    enforce: 'pre',
    transform(code, id) {
      if (!/\.[jt]sx$/.test(id)) return null;
      if (id.includes('node_modules')) return null;
      const rel = path.relative(process.cwd(), id).replace(/\\/g, '/');
      let line = 1;
      let lastIndex = 0;
      const out: string[] = [];
      let match: RegExpExecArray | null;
      const re = new RegExp(JSX_OPEN.source, 'g');
      while ((match = re.exec(code)) !== null) {
        const before = code.slice(lastIndex, match.index);
        line += (before.match(/\n/g) || []).length;
        out.push(before);
        const tag = match[1];
        const attrs = match[2] || '';
        const selfClose = match[3] || '';
        // Skip fragments and tags that already have data-loc.
        if (tag === 'Fragment' || /\bdata-loc\s*=/.test(attrs)) {
          out.push(match[0]);
        } else {
          const col = match.index - (code.lastIndexOf('\n', match.index - 1) + 1) + 1;
          const loc = `${rel}:${line}:${col}`;
          out.push(`<${tag}${attrs} data-loc="${loc}"${selfClose}>`);
        }
        // Account for newlines inside the matched open tag.
        line += (match[0].match(/\n/g) || []).length;
        lastIndex = match.index + match[0].length;
      }
      out.push(code.slice(lastIndex));
      return { code: out.join(''), map: null };
    },
  };
}

export default dataLocTagger;

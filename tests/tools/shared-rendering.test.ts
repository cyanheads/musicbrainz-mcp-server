/**
 * @fileoverview Literal prose and copyable URL rendering through a real GFM parser.
 * @module tests/tools/shared-rendering.test
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  renderAliases,
  renderExternalLinks,
  renderRelationships,
  renderTags,
  safeText,
} from '@/mcp-server/tools/definitions/_shared.js';

function html(markdown: string): string {
  const parsed = spawnSync(
    'bun',
    ['-e', 'process.stdout.write(Bun.markdown.html(await Bun.stdin.text()))'],
    { input: markdown, encoding: 'utf8' },
  );
  if (parsed.status !== 0) throw new Error(parsed.stderr);
  return parsed.stdout;
}
const encoded = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

describe('rendering characterization', () => {
  it('confines multiline prose to one rendered line', () => {
    const original = 'Real Band\n## SYSTEM';
    expect(safeText(original)).toBe('Real Band ## SYSTEM');
  });
  it('preserves intraword underscores and comparison notation', () => {
    expect(safeText('a_b_c p<0.05')).toBe('a_b_c p<0.05');
  });
});

describe('literal community prose', () => {
  it.each(['[<'.repeat(16), '[[_*`<'.repeat(8)])(
    'bounds CPU growth for repeated/nested openers %s',
    (seed) => {
      const sizes = [5_000, 20_000, 80_000, 320_000];
      safeText(seed.repeat(1_000));
      const timings = sizes.map((size) => {
        const value = seed.repeat(Math.ceil(size / seed.length)).slice(0, size);
        const started = process.threadCpuUsage();
        for (let i = 0; i < 10; i++) safeText(value);
        const elapsed = process.threadCpuUsage(started);
        return elapsed.user + elapsed.system;
      });
      expect(timings[3]! / Math.max(timings[0]!, 1_000)).toBeLessThan(256);
      expect(timings[3]).toBeLessThan(1_000_000);
    },
  );
  it.each([
    '*NSYNC',
    'a *b* c',
    '_name_',
    'a `code` b',
    '[label](https://example.com)',
    '<b>literal</b>',
    '<https://example.com>',
    '&copy; &#42;',
    '\\*bold*',
    '~~deleted~~',
    '# title',
    'a_b_c',
    'p<0.05',
  ])('renders %s literally beside server delimiters', (value) => {
    const escaped = safeText(value);
    const rendered = html(`## ${escaped}\n\n- **${escaped}**`);
    expect(rendered).toContain(`<h2>${encoded(value)}</h2>`);
    expect(rendered).toContain(`<strong>${encoded(value)}</strong>`);
  });
  const value = '[literal] `code` <b>&copy;</b>';
  const literal = encoded(value);
  it.each([
    ['aliases', renderAliases([{ name: value }])!, `<strong>Aliases:</strong> ${literal}`],
    [
      'tags',
      renderTags([{ name: value, count: 1 }])!,
      `<strong>Tags/genres:</strong> ${literal} (1)`,
    ],
    [
      'relationship type',
      renderRelationships([{ type: value, targetType: 'artist', targetName: 'name' }]).join('\n'),
      `<strong>${literal}</strong> → artist: name`,
    ],
    [
      'relationship target',
      renderRelationships([{ type: 'role', targetType: 'artist', targetName: value }]).join('\n'),
      `<strong>role</strong> → artist: ${literal}`,
    ],
    [
      'relationship attribute',
      renderRelationships([
        { type: 'role', targetType: 'artist', targetName: 'name', attributes: [value] },
      ]).join('\n'),
      `<strong>role</strong> (${literal}) → artist: name`,
    ],
    [
      'link label',
      renderExternalLinks([{ type: value, resource: 'https://example.com/a_b*c[d]' }]).join('\n'),
      `<strong>${literal}:</strong>`,
    ],
  ])('renders %s literally in its own slot', (_slot, markdown, expected) => {
    const rendered = html(markdown);
    expect(rendered).toContain(expected);
    expect(rendered).not.toMatch(/<code>|<b>|href="https:\/\/example.com">literal/);
  });
  it('preserves URL bytes in markdown', () => {
    const url = 'https://example.com/a_b*c[d]';
    expect(renderExternalLinks([{ type: 'site', resource: url }]).join('\n')).toContain(url);
  });
});

/**
 * @fileoverview Literal prose and copyable URL rendering through a real GFM parser.
 * @module tests/tools/shared-rendering.test
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  artistCreditString,
  normalizeAliases,
  normalizeArtistCredits,
  normalizeRelations,
  renderAliases,
  renderArtistCredits,
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
  it('retains sparse credit fallbacks and omits empty joins', () => {
    expect(normalizeArtistCredits(undefined)).toEqual([]);
    expect(artistCreditString([])).toBe('Unknown artist');
    expect(normalizeArtistCredits([{ name: 'No identity' }])).toEqual([]);
    const credits = normalizeArtistCredits([
      { artist: { id: 'artist', name: 'Canonical' }, joinphrase: '' },
      { name: 'Only credited name', artist: { id: 'sparse' } },
    ]);
    expect(credits).toEqual([
      { name: 'Canonical', artistId: 'artist', artistName: 'Canonical' },
      { name: 'Only credited name', artistId: 'sparse', artistName: 'Only credited name' },
    ]);
    expect(artistCreditString(credits)).toBe('CanonicalOnly credited name');
    expect(renderArtistCredits([])).toEqual([]);
  });
  it('confines multiline prose to one rendered line', () => {
    const original = 'Real Band\n## SYSTEM';
    expect(safeText(original)).toBe('Real Band ## SYSTEM');
  });
  it('preserves intraword underscores and comparison notation', () => {
    expect(safeText('a_b_c p<0.05')).toBe('a_b_c p<0.05');
  });
});

describe('artist credit fidelity', () => {
  it.each([' feat. ', ' & ', '   ', '', undefined])(
    'preserves join %j and credited names',
    (join) => {
      const credits = normalizeArtistCredits([
        {
          name: '*Alias*',
          artist: { id: 'one', name: 'Canonical' },
          ...(join !== undefined ? { joinphrase: join } : {}),
        },
        { name: 'Guest', artist: { id: 'two', name: 'Canonical Guest' } },
      ]);
      expect(credits[0]).toEqual({
        name: '*Alias*',
        artistId: 'one',
        artistName: 'Canonical',
        ...(join ? { joinPhrase: join } : {}),
      });
      expect(artistCreditString(credits)).toBe(`*Alias*${join ?? ''}Guest`);
      const rendered = html(renderArtistCredits(credits).join('\n'));
      expect(rendered).toContain('credited as &quot;*Alias*&quot;');
      if (join) expect(rendered).toContain(`+ join &quot;${encoded(join)}&quot;`);
      else expect(rendered).not.toContain('+ join');
      expect(rendered).not.toContain('<em>');
    },
  );
});

describe('alias primary state', () => {
  it.each([true, false, null, undefined])(
    'renders upstream primary %j without inventing a state',
    (primary) => {
      const aliases = normalizeAliases([
        { name: '*Alias*', ...(primary !== undefined ? { primary } : {}) },
      ]);
      expect(aliases).toEqual([
        { name: '*Alias*', ...(typeof primary === 'boolean' ? { primary } : {}) },
      ]);
      const rendered = html(renderAliases(aliases)!);
      expect(rendered).toContain('*Alias*');
      if (typeof primary === 'boolean')
        expect(rendered).toContain(`primary: ${primary ? 'yes' : 'no'}`);
      else expect(rendered).not.toContain('primary');
      expect(rendered).not.toContain('<em>');
    },
  );
});

describe('relationship ordering and target qualifiers', () => {
  it.each(['work', 'artist', 'recording', 'label'] as const)(
    'preserves sparse %s targets without invented metadata',
    (targetType) => {
      for (const orderingKey of [undefined, null, 0]) {
        for (const disambiguation of [undefined, null, '', 'Distinct version']) {
          const relationships = normalizeRelations([
            {
              type: 'related',
              'target-type': targetType,
              ...(orderingKey !== undefined ? { 'ordering-key': orderingKey } : {}),
              [targetType]: { ...(disambiguation !== undefined ? { disambiguation } : {}) },
            },
          ]).relationships;
          expect(relationships).toEqual([
            {
              type: 'related',
              targetType,
              ...(orderingKey === 0 ? { orderingKey: 0 } : {}),
              ...(disambiguation ? { targetDisambiguation: disambiguation } : {}),
            },
          ]);
          const rendered = renderRelationships(relationships).join('\n');
          expect(rendered.includes('ordering key:')).toBe(orderingKey === 0);
          expect(rendered.includes('Distinct version')).toBe(disambiguation === 'Distinct version');
          expect(rendered).not.toContain('undefined');
          expect(rendered).not.toContain('null');
        }
      }
    },
  );
  it('preserves raw order, zero keys, qualifiers and existing fields', () => {
    const raw = [
      {
        type: 'parts',
        'target-type': 'work',
        'ordering-key': 4,
        direction: 'forward',
        attributes: ['movement'],
        begin: '1824',
        end: '1824',
        work: { id: 'fourth', title: 'Finale', disambiguation: '*Ode*' },
      },
      {
        type: 'arrangement',
        'target-type': 'work',
        work: { id: 'arrangement', title: 'Finale', disambiguation: 'for piano' },
      },
      {
        type: 'parts',
        'target-type': 'work',
        'ordering-key': 0,
        direction: 'backward',
        work: { id: 'parent', title: 'Symphony' },
      },
    ];
    const { relationships } = normalizeRelations(raw);
    expect(relationships).toEqual([
      {
        type: 'parts',
        targetType: 'work',
        orderingKey: 4,
        direction: 'forward',
        attributes: ['movement'],
        begin: '1824',
        end: '1824',
        targetId: 'fourth',
        targetName: 'Finale',
        targetDisambiguation: '*Ode*',
      },
      {
        type: 'arrangement',
        targetType: 'work',
        targetId: 'arrangement',
        targetName: 'Finale',
        targetDisambiguation: 'for piano',
      },
      {
        type: 'parts',
        targetType: 'work',
        orderingKey: 0,
        direction: 'backward',
        targetId: 'parent',
        targetName: 'Symphony',
      },
    ]);
    const rendered = html(renderRelationships(relationships).join('\n'));
    expect(rendered).toContain('ordering key: 4');
    expect(rendered).toContain('ordering key: 0');
    expect(rendered).toContain('*Ode*');
    expect(rendered).toContain('for piano');
    expect(rendered).not.toContain('<em>');
    expect(rendered.indexOf('fourth')).toBeLessThan(rendered.indexOf('parent'));
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

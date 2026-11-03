/**
 * @fileoverview Shared credit and alias metadata through each consuming tool's dual-surface contract.
 * @module tests/tools/metadata-contract.test
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.fn();
const search = vi.fn();
const browse = vi.fn();
const resolveIsrc = vi.fn();
vi.mock('@/services/musicbrainz/musicbrainz-service.js', async () => ({
  ...(await vi.importActual<typeof import('@/services/musicbrainz/musicbrainz-service.js')>(
    '@/services/musicbrainz/musicbrainz-service.js',
  )),
  getMusicBrainzService: () => ({ lookup, search, browse, resolveIsrc }),
}));
vi.mock('@/services/cover-art/cover-art-service.js', () => ({
  getCoverArtService: () => ({ getImages: async () => ({ found: false, images: [] }) }),
}));

const { getArtistTool } = await import('@/mcp-server/tools/definitions/get-artist.tool.js');
const { getLabelTool } = await import('@/mcp-server/tools/definitions/get-label.tool.js');
const { getWorkTool } = await import('@/mcp-server/tools/definitions/get-work.tool.js');
const { getRecordingTool } = await import('@/mcp-server/tools/definitions/get-recording.tool.js');
const { getReleaseGroupTool } = await import(
  '@/mcp-server/tools/definitions/get-release-group.tool.js'
);
const { getReleaseTool } = await import('@/mcp-server/tools/definitions/get-release.tool.js');
const { entityResource } = await import('@/mcp-server/resources/definitions/entity.resource.js');
const { searchEntitiesTool } = await import(
  '@/mcp-server/tools/definitions/search-entities.tool.js'
);
const { browseEntitiesTool } = await import(
  '@/mcp-server/tools/definitions/browse-entities.tool.js'
);
const { lookupIdentifierTool } = await import(
  '@/mcp-server/tools/definitions/lookup-identifier.tool.js'
);
const MBID = 'a345bbb3-4f16-448c-adf1-4f58d1ae32f5';
const credits = [
  { name: 'Credited Queen', artist: { id: 'queen', name: 'Queen' }, joinphrase: ' feat. ' },
  { name: 'Credited Bowie', artist: { id: 'bowie', name: 'David Bowie' } },
];
const creditString = 'Credited Queen feat. Credited Bowie';
const raw = { id: MBID, title: 'Collaboration', score: 100, 'artist-credit': credits };
function text(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}
afterEach(() => vi.resetAllMocks());

describe('lookup metadata characterization', () => {
  it('preserves repeated recording occurrences and raw work attributes without mutating cached data', async () => {
    const tracks = [
      { position: 1, title: 'First', recording: { id: 'same' } },
      { position: 2, title: 'Second', recording: { id: 'same' } },
    ];
    lookup.mockResolvedValueOnce({ id: MBID, title: 'Edition', media: [{ position: 1, tracks }] });
    const release = await runToolContract(getReleaseTool, { mbid: MBID });
    expect(release.structuredContent).toMatchObject({
      mediaTotal: 1,
      trackTotal: 2,
      media: [
        {
          tracks: [
            { title: 'First', recordingId: 'same' },
            { title: 'Second', recordingId: 'same' },
          ],
        },
      ],
    });
    const attributes = [
      { type: 'ASCAP', value: '0001' },
      { type: 'ASCAP', value: ' 0002 ' },
    ];
    const work = { id: MBID, title: 'Work', attributes };
    lookup.mockResolvedValueOnce(work);
    const resource = await entityResource.handler(
      entityResource.params!.parse({ entity_type: 'work', mbid: MBID }),
      createMockContext({ errors: entityResource.errors }),
    );
    expect(resource).toMatchObject({ attributes });
    expect(work).toEqual({ id: MBID, title: 'Work', attributes });
  });
});

describe('track-specific credits', () => {
  it('keeps credits per occurrence through whole-medium pages and both surfaces', async () => {
    const trackCredits = [
      {
        name: 'Track Alias',
        artist: { id: 'performer-one', name: 'Canonical One' },
        joinphrase: '   ',
      },
      { name: 'Guest Alias', artist: { id: 'performer-two', name: 'Canonical Two' } },
    ];
    const recording = {
      id: 'repeated-recording',
      'artist-credit': [{ artist: { id: 'wrong', name: 'Recording Artist' } }],
    };
    const rawRelease = {
      id: MBID,
      title: 'Compilation',
      'artist-credit': [{ artist: { id: 'various', name: 'Various Artists' } }],
      media: [
        {
          position: 1,
          'track-count': 3,
          tracks: [
            {
              position: 1,
              number: 'A1',
              title: 'Credited',
              recording,
              'artist-credit': trackCredits,
            },
            { position: 2, title: 'Absent', recording },
            { position: 3, title: 'Empty', recording, 'artist-credit': [] },
          ],
        },
        {
          position: 2,
          tracks: [
            { position: 1, title: 'Reprise', recording, 'artist-credit': [trackCredits[1]] },
          ],
        },
      ],
    };
    lookup.mockResolvedValue(rawRelease);
    const first = await runToolContract(getReleaseTool, { mbid: MBID, media_limit: 1 });
    expect(first.structuredContent).toMatchObject({
      mediaTotal: 2,
      trackTotal: 4,
      truncated: true,
      media: [
        {
          tracks: [
            {
              number: 'A1',
              artistCreditString: 'Track Alias   Guest Alias',
              artistCredit: [
                {
                  name: 'Track Alias',
                  artistName: 'Canonical One',
                  artistId: 'performer-one',
                  joinPhrase: '   ',
                },
                { name: 'Guest Alias', artistName: 'Canonical Two', artistId: 'performer-two' },
              ],
            },
            { title: 'Absent' },
            { title: 'Empty', artistCredit: [] },
          ],
        },
      ],
    });
    const rows = (first.structuredContent as { media: { tracks: object[] }[] }).media[0]!.tracks;
    expect(rows[1]).not.toHaveProperty('artistCredit');
    expect(rows[1]).not.toHaveProperty('artistCreditString');
    expect(rows[2]).not.toHaveProperty('artistCreditString');
    for (const value of [
      'Track Alias   Guest Alias',
      'Canonical One',
      'performer-one',
      'Canonical Two',
      'performer-two',
      'join "   "',
    ])
      expect(text(first)).toContain(value);
    expect(text(first)).not.toContain('Recording Artist');
    expect(text(first)).not.toContain('Unknown artist');
    const second = await runToolContract(getReleaseTool, {
      mbid: MBID,
      media_limit: 1,
      media_offset: 1,
    });
    expect(second.structuredContent).toMatchObject({
      mediaTotal: 2,
      trackTotal: 4,
      media: [
        {
          position: 2,
          tracks: [{ recordingId: 'repeated-recording', artistCreditString: 'Guest Alias' }],
        },
      ],
    });
    expect(text(second)).toContain('Guest Alias');
    const exhausted = await runToolContract(getReleaseTool, { mbid: MBID, media_offset: 2 });
    expect(exhausted.structuredContent).toMatchObject({ media: [], mediaTotal: 2, trackTotal: 4 });
    expect(text(exhausted)).not.toContain('performer-one');
    expect(rawRelease.media[0]!.tracks[0]!['artist-credit']).toEqual(trackCredits);
  });
});

describe('work attributes', () => {
  it.each([true, false])(
    'preserves ordered repeated and sparse attributes with relationships %s',
    async (inc_relationships) => {
      const attributes = [
        { type: 'ASCAP', value: '00001' },
        { type: 'ASCAP', value: ' 00002 ' },
        { type: 'Key', value: 'G major' },
        { type: 'Only type' },
        { value: 'Only value' },
        {},
      ];
      lookup.mockResolvedValueOnce({ id: MBID, title: 'Work', attributes });
      const result = await runToolContract(getWorkTool, { mbid: MBID, inc_relationships });
      expect(result.structuredContent).toMatchObject({ attributes });
      for (const value of [
        'ASCAP',
        '00001',
        ' 00002 ',
        'Key',
        'G major',
        'Only type',
        'Only value',
      ])
        expect(text(result)).toContain(value);
      expect(text(result)).not.toContain('undefined');
      expect(text(result)).toContain('- Attribute metadata unavailable.');
      expect(text(result).indexOf('00001')).toBeLessThan(text(result).indexOf('00002'));
    },
  );
  it.each([undefined, []])('makes no attribute claim for %j', async (attributes) => {
    lookup.mockResolvedValueOnce({
      id: MBID,
      title: 'Work',
      ...(attributes ? { attributes } : {}),
    });
    const result = await runToolContract(getWorkTool, { mbid: MBID });
    expect(result.structuredContent).toMatchObject({ attributes: [] });
    expect(text(result)).not.toContain('### Attributes');
  });
});

describe('lookup relationship includes', () => {
  it.each([
    { definition: getReleaseTool, entityType: 'release', include: 'url-rels', target: 'url' },
    {
      definition: getReleaseGroupTool,
      entityType: 'release-group',
      include: 'url-rels',
      target: 'url',
    },
    {
      definition: getRecordingTool,
      entityType: 'recording',
      include: 'recording-rels',
      target: 'recording',
    },
    { definition: getLabelTool, entityType: 'label', include: 'label-rels', target: 'label' },
  ])(
    '$entityType requests and renders $include in tool and raw resource',
    async ({ definition, entityType, include, target }) => {
      const relations =
        target === 'url'
          ? [
              {
                type: 'wikidata',
                'target-type': 'url',
                url: { resource: 'https://example.com/id_a*b[c]' },
              },
            ]
          : [
              {
                type: 'related',
                'target-type': target,
                direction: 'backward',
                attributes: ['role'],
                begin: '1990',
                end: '2000',
                'ordering-key': 0,
                [target]: {
                  id: 'target-id',
                  name: 'Label Name',
                  title: 'Recording Title',
                  disambiguation: 'Qualifier',
                },
              },
              { type: 'sparse', 'target-type': target },
              ...Array.from({ length: 26 }, (_, i) => ({
                type: 'related',
                'target-type': target,
                [target]: { id: `tail-${i}` },
              })),
            ];
      lookup.mockImplementation(async (_type, _id, options) => ({
        id: MBID,
        name: 'Entity',
        title: 'Entity',
        relations: options.inc.includes(include) ? relations : [],
      }));
      const result = await runToolContract(definition, { mbid: MBID });
      expect(result.isError).not.toBe(true);
      expect(lookup.mock.calls[0]?.[2].inc).toContain(include);
      if (target === 'url') {
        expect(result.structuredContent).toMatchObject({
          externalLinks: [{ type: 'wikidata', resource: 'https://example.com/id_a*b[c]' }],
        });
        expect(text(result)).toContain('https://example.com/id_a*b[c]');
      } else {
        expect(result.structuredContent).toMatchObject({
          relationships: [
            {
              type: 'related',
              targetType: target,
              targetId: 'target-id',
              direction: 'backward',
              attributes: ['role'],
              begin: '1990',
              end: '2000',
              orderingKey: 0,
              targetDisambiguation: 'Qualifier',
            },
            { type: 'sparse', targetType: target },
            ...Array.from({ length: 26 }, (_, i) => ({ targetId: `tail-${i}` })),
          ],
        });
        for (const value of [
          'target-id',
          'backward',
          'role',
          '1990',
          '2000',
          'ordering key: 0',
          'Qualifier',
          'tail-25',
        ])
          expect(text(result)).toContain(value);
      }
      const resource = await entityResource.handler(
        entityResource.params!.parse({ entity_type: entityType, mbid: MBID }),
        createMockContext({ errors: entityResource.errors }),
      );
      expect(lookup.mock.calls[1]?.[2].inc).toContain(include);
      expect(resource).toMatchObject({ relations });
    },
  );
  it('keeps recording relationships disabled even when cached upstream relations are present', async () => {
    lookup.mockResolvedValueOnce({
      id: MBID,
      title: 'Recording',
      relations: [
        {
          type: 'samples material',
          'target-type': 'recording',
          recording: { id: 'other', title: 'Other' },
        },
      ],
    });
    const result = await runToolContract(getRecordingTool, {
      mbid: MBID,
      inc_relationships: false,
    });
    expect(result.structuredContent).toMatchObject({ relationships: [], externalLinks: [] });
    expect(lookup.mock.calls[0]?.[2].inc).not.toContain('recording-rels');
    expect(text(result)).not.toContain('Other');
  });
});

describe('area and rights metadata', () => {
  it('renders explicitly empty location objects without inventing members', async () => {
    lookup.mockResolvedValueOnce({ id: MBID, name: 'Entity', 'begin-area': {}, 'end-area': {} });
    const result = await runToolContract(getArtistTool, { mbid: MBID });
    expect(result.structuredContent).toMatchObject({ beginArea: {}, endArea: {} });
    expect(text(result)).toContain('**Begin area:** Metadata unavailable.');
    expect(text(result)).toContain('**End area:** Metadata unavailable.');
  });
  it.each([getArtistTool, getLabelTool])(
    '%s preserves area discovery and string identifiers',
    async (definition) => {
      lookup.mockResolvedValueOnce({
        id: MBID,
        name: 'Entity',
        area: { id: 'area-mbid', name: 'Iceland' },
        'begin-area': { id: 'begin-mbid', name: 'Reykjavík' },
        'end-area': { name: 'End city' },
        ipis: ['00001', '00002'],
        isnis: ['0000000110013823'],
      });
      const result = await runToolContract(definition, { mbid: MBID });
      expect(result.structuredContent).toMatchObject({
        area: 'Iceland',
        areaId: 'area-mbid',
        ipis: ['00001', '00002'],
        isnis: ['0000000110013823'],
      });
      for (const value of ['Iceland', 'area-mbid', '00001', '00002', '0000000110013823'])
        expect(text(result)).toContain(value);
      if (definition === getArtistTool) {
        expect(result.structuredContent).toMatchObject({
          beginArea: { mbid: 'begin-mbid', name: 'Reykjavík' },
          endArea: { name: 'End city' },
        });
        for (const value of ['begin-mbid', 'Reykjavík', 'End city'])
          expect(text(result)).toContain(value);
      }
    },
  );
  it.each([null, undefined, { id: 'id-only' }, { name: 'Name only' }])(
    'preserves known area members for %j',
    async (area) => {
      lookup.mockResolvedValueOnce({
        id: MBID,
        name: 'Entity',
        area,
        'begin-area': area,
        'end-area': area,
        ipis: [],
        isnis: [],
      });
      const result = await runToolContract(getArtistTool, {
        mbid: MBID,
        inc_relationships: false,
        inc_release_groups: false,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ipis: [], isnis: [] });
      if (!area) {
        for (const key of ['area', 'areaId', 'beginArea', 'endArea'])
          expect(result.structuredContent).not.toHaveProperty(key);
      } else if ('id' in area) {
        expect(result.structuredContent).toMatchObject({
          areaId: 'id-only',
          beginArea: { mbid: 'id-only' },
          endArea: { mbid: 'id-only' },
        });
        expect(result.structuredContent).not.toHaveProperty('area');
        expect(text(result)).toContain('id-only');
      } else {
        expect(result.structuredContent).toMatchObject({
          area: 'Name only',
          beginArea: { name: 'Name only' },
          endArea: { name: 'Name only' },
        });
        expect(result.structuredContent).not.toHaveProperty('areaId');
        expect(text(result)).toContain('Name only');
      }
      expect(text(result)).not.toContain('**IPIs:**');
      expect(text(result)).not.toContain('**ISNIs:**');
    },
  );
});

describe('credited names and joins on both surfaces', () => {
  it.each([getRecordingTool, getReleaseGroupTool, getReleaseTool])(
    '%s lookup preserves credit details',
    async (definition) => {
      lookup.mockResolvedValueOnce(raw);
      const result = await runToolContract(definition, { mbid: MBID });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        artistCreditString: creditString,
        artistCredit: [
          { name: 'Credited Queen', artistName: 'Queen', artistId: 'queen', joinPhrase: ' feat. ' },
          { name: 'Credited Bowie', artistName: 'David Bowie', artistId: 'bowie' },
        ],
      });
      expect(text(result)).toContain(creditString);
      expect(text(result)).toContain('join " feat. "');
      expect(text(result)).toContain('David Bowie');
    },
  );
  it.each(['recording', 'release-group', 'release'] as const)(
    'search and browse %s use the same credit',
    async (entityType) => {
      const key = entityType === 'release-group' ? 'release-groups' : `${entityType}s`;
      search.mockResolvedValueOnce({ count: 1, [key]: [raw] });
      browse.mockResolvedValueOnce({ [`${entityType}-count`]: 1, [key]: [raw] });
      const searched = await runToolContract(searchEntitiesTool, {
        entityType,
        query: 'Collaboration',
      });
      const browsed = await runToolContract(browseEntitiesTool, {
        target_type: entityType,
        link: { artist: MBID },
      });
      expect(searched.structuredContent).toMatchObject({
        results: [{ artistCredit: creditString }],
      });
      expect(browsed.structuredContent).toMatchObject({
        entities: [{ artistCredit: creditString }],
      });
      expect(text(searched)).toContain(creditString);
      expect(text(browsed)).toContain(creditString);
    },
  );
  it.each(['isrc', 'barcode'] as const)('%s resolution preserves the credit', async (id_type) => {
    resolveIsrc.mockResolvedValueOnce({ recordings: [raw] });
    search.mockResolvedValueOnce({ count: 1, releases: [raw] });
    const result = await runToolContract(lookupIdentifierTool, {
      id_type,
      value: id_type === 'isrc' ? 'GBUM71029601' : '075678164125',
    });
    expect(result.structuredContent).toMatchObject({
      result: {
        [id_type === 'isrc' ? 'recordings' : 'releases']: [{ artistCredit: creditString }],
      },
    });
    expect(text(result)).toContain(creditString);
  });
});

describe('alias primary state on both surfaces', () => {
  it.each([getArtistTool, getLabelTool, getWorkTool])(
    '%s retains true, false and unknown aliases',
    async (definition) => {
      lookup.mockResolvedValueOnce({
        id: MBID,
        name: 'Entity',
        title: 'Entity',
        aliases: [
          { name: 'Primary', primary: true },
          { name: 'Secondary', primary: false },
          { name: 'Unknown', primary: null },
        ],
      });
      const result = await runToolContract(definition, { mbid: MBID });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        aliases: [
          { name: 'Primary', primary: true },
          { name: 'Secondary', primary: false },
          { name: 'Unknown' },
        ],
      });
      expect(text(result)).toContain('Primary [primary: yes]');
      expect(text(result)).toContain('Secondary [primary: no]');
      expect(text(result)).toMatch(/Unknown(?:\n|;|$)/);
    },
  );
});

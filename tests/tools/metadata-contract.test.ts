/**
 * @fileoverview Shared credit and alias metadata through each consuming tool's dual-surface contract.
 * @module tests/tools/metadata-contract.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

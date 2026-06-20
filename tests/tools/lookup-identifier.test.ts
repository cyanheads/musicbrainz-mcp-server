/**
 * @fileoverview Tests for the lookup_identifier tool: the three discriminated
 * result arms (recordings / works / releases), and identifier_not_found.
 * @module tests/tools/lookup-identifier.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const resolveIsrcMock = vi.fn();
const resolveIswcMock = vi.fn();
const searchMock = vi.fn();

vi.mock('@/services/musicbrainz/musicbrainz-service.js', () => ({
  getMusicBrainzService: () => ({
    resolveIsrc: resolveIsrcMock,
    resolveIswc: resolveIswcMock,
    search: searchMock,
  }),
  MusicBrainzService: class {},
}));

const { lookupIdentifierTool } = await import(
  '@/mcp-server/tools/definitions/lookup-identifier.tool.js'
);

afterEach(() => {
  resolveIsrcMock.mockReset();
  resolveIswcMock.mockReset();
  searchMock.mockReset();
});

describe('lookup_identifier', () => {
  it('resolves an ISRC to a recordings arm and surfaces the artist credit', async () => {
    // The ISRC endpoint is now requested with inc=artist-credits, so the
    // credit is populated rather than falling back to "Unknown artist".
    resolveIsrcMock.mockResolvedValueOnce({
      isrc: 'USRC17607839',
      recordings: [
        {
          id: 'rec1',
          title: 'Crazy Eyes',
          length: 184000,
          'artist-credit': [{ name: 'Daryl Hall & John Oates', artist: { id: 'hall-oates' } }],
        },
      ],
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const input = lookupIdentifierTool.input.parse({ id_type: 'isrc', value: 'USRC17607839' });
    const { result } = await lookupIdentifierTool.handler(input, ctx);
    expect(result.kind).toBe('recordings');
    if (result.kind === 'recordings') {
      expect(result.recordings[0]?.mbid).toBe('rec1');
      expect(result.recordings[0]?.artistCredit).toBe('Daryl Hall & John Oates');
    }
  });

  it('resolves an ISWC to a works arm', async () => {
    resolveIswcMock.mockResolvedValueOnce({
      'work-count': 1,
      works: [{ id: 'w1', title: 'Composition' }],
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const input = lookupIdentifierTool.input.parse({ id_type: 'iswc', value: 'T-010.140.236-1' });
    const { result } = await lookupIdentifierTool.handler(input, ctx);
    expect(result.kind).toBe('works');
    if (result.kind === 'works') expect(result.works[0]?.title).toBe('Composition');
  });

  it('resolves a barcode to a releases arm via search', async () => {
    searchMock.mockResolvedValueOnce({
      count: 1,
      releases: [{ id: 'rel1', title: 'Album', score: 100, 'artist-credit': [] }],
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const input = lookupIdentifierTool.input.parse({ id_type: 'barcode', value: '075678164125' });
    const { result } = await lookupIdentifierTool.handler(input, ctx);
    expect(result.kind).toBe('releases');
    if (result.kind === 'releases') expect(result.releases[0]?.score).toBe(100);
    expect(searchMock).toHaveBeenCalledWith(
      'release',
      'barcode:075678164125',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('throws identifier_not_found when an ISRC resolves to zero recordings', async () => {
    resolveIsrcMock.mockResolvedValueOnce({ isrc: 'USRC17607839', recordings: [] });
    const ctx = createMockContext({ tenantId: 'test', errors: lookupIdentifierTool.errors });
    const input = lookupIdentifierTool.input.parse({ id_type: 'isrc', value: 'USRC17607839' });
    await expect(lookupIdentifierTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'identifier_not_found' },
    });
  });
});

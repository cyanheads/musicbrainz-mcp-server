/**
 * @fileoverview Browse contract tests for parent keys, pagination, and entity fields.
 * @module tests/tools/browse-entities.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const browse = vi.fn();
vi.mock('@/services/musicbrainz/musicbrainz-service.js', () => ({
  getMusicBrainzService: () => ({ browse }),
  MusicBrainzService: {
    pluralKey: (type: string) => (type === 'release' ? 'releases' : `${type}s`),
  },
}));
const { browseEntitiesTool } = await import(
  '@/mcp-server/tools/definitions/browse-entities.tool.js'
);
const MBID = 'b1392450-e666-3926-a536-22c65f834433';
afterEach(() => browse.mockReset());

describe('browse contract characterization', () => {
  it.each([0, 2, 4, 6])('preserves upstream totals at offset %s', async (offset) => {
    const releases = offset < 4 ? [{ id: `${offset}`, title: 'Edition', status: 'Official' }] : [];
    browse.mockResolvedValueOnce({ 'release-count': 4, releases });
    const result = await runToolContract(browseEntitiesTool, {
      target_type: 'release',
      link: { 'release-group': MBID },
      limit: 2,
      offset,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ offset, totalCount: 4 });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining(`Offset:** ${offset}`),
        }),
      ]),
    );
  });
});

describe('browse parent and release fields', () => {
  it.each(['release-group', 'release', 'recording'] as const)(
    'renders credited %s results on both surfaces',
    async (target_type) => {
      const key = target_type === 'release-group' ? 'release-groups' : `${target_type}s`;
      browse.mockResolvedValueOnce({
        [`${target_type}-count`]: 1,
        [key]: [
          {
            id: MBID,
            title: 'Title',
            'artist-credit': [{ artist: { id: MBID, name: 'Radiohead' }, name: 'Radiohead' }],
          },
        ],
      });
      const result = await runToolContract(browseEntitiesTool, {
        target_type,
        link: { artist: MBID },
      });
      expect(result.structuredContent).toMatchObject({ entities: [{ artistCredit: 'Radiohead' }] });
      expect(JSON.stringify(result.content)).toContain('Radiohead');
    },
  );
  it('preserves the unknown-credit fallback when upstream omits credits', async () => {
    browse.mockResolvedValueOnce({
      'recording-count': 1,
      recordings: [{ id: MBID, title: 'Title' }],
    });
    const result = await runToolContract(browseEntitiesTool, {
      target_type: 'recording',
      link: { work: MBID },
    });
    expect(result.structuredContent).toMatchObject({
      entities: [{ artistCredit: 'Unknown artist' }],
    });
    expect(JSON.stringify(result.content)).toContain('Unknown artist');
  });
  it.each(['release-group', 'releaseGroup', 'release_group'])('accepts %s', async (key) => {
    browse.mockResolvedValueOnce({
      'release-count': 1,
      releases: [{ id: MBID, title: 'Edition', status: 'Official' }],
    });
    const result = await runToolContract(browseEntitiesTool, {
      target_type: 'release',
      link: { [key]: MBID },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      linkType: 'release-group',
      entities: [{ status: 'Official' }],
    });
    expect((result.structuredContent as { entities: object[] }).entities[0]).not.toHaveProperty(
      'type',
    );
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('Official') }),
      ]),
    );
  });
  it('accepts a release parent for recording enumeration', async () => {
    browse.mockResolvedValueOnce({ 'recording-count': 0, recordings: [] });
    const result = await runToolContract(browseEntitiesTool, {
      target_type: 'recording',
      link: { release: MBID },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ linkType: 'release', totalCount: 0 });
  });
  it.each([
    [{ releaseGroup: MBID, 'release-group': MBID }, 'collision'],
    [{ releaseGroup: MBID, release_group: MBID }, 'collision'],
    [{ misspelled: MBID }, 'misspelled'],
    [{ artist: MBID, misspelled: MBID }, 'misspelled'],
    [{}, 'exactly one'],
    [{ artist: MBID, label: MBID }, 'exactly one'],
  ])('rejects invalid parents %j', async (link, detail) => {
    const result = await runToolContract(browseEntitiesTool, { target_type: 'release', link });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_link' } },
    });
    expect(JSON.stringify(result.content)).toContain(detail);
    expect(browse).not.toHaveBeenCalled();
  });
});

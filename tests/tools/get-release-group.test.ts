/**
 * @fileoverview Tests for the get_release_group tool handler: full payload,
 * sparse payload (omitted upstream fields preserved as absent), error-contract
 * mapping (invalid_mbid / entity_not_found), and the truncation lock — the
 * embedded releases list is capped at one page (25) by the lookup endpoint, so
 * hitting that cap must surface a truncation enrichment pointing at browse. The
 * MusicBrainz service is mocked at the accessor boundary.
 * @module tests/tools/get-release-group.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawRelease, RawReleaseGroup } from '@/services/musicbrainz/types.js';

const lookupMock = vi.fn();

vi.mock('@/services/musicbrainz/musicbrainz-service.js', () => ({
  getMusicBrainzService: () => ({ lookup: lookupMock }),
  MusicBrainzService: class {},
}));

const { getReleaseGroupTool } = await import(
  '@/mcp-server/tools/definitions/get-release-group.tool.js'
);

afterEach(() => lookupMock.mockReset());

const fullReleaseGroup: RawReleaseGroup = {
  id: 'b1392450-e666-3926-a536-22c65f834433',
  title: 'OK Computer',
  'primary-type': 'Album',
  'first-release-date': '1997-05-21',
  'artist-credit': [{ name: 'Radiohead', artist: { id: 'radiohead', name: 'Radiohead' } }],
  releases: [
    { id: 'rel1', title: 'OK Computer', date: '1997-05-21', country: 'GB', status: 'Official' },
    { id: 'rel2', title: 'OK Computer', date: '1997-06-17', country: 'US', status: 'Official' },
  ],
  tags: [{ name: 'alternative rock', count: 5 }],
};

describe('get_release_group', () => {
  it('maps a full payload with releases and artist credit', async () => {
    lookupMock.mockResolvedValueOnce(fullReleaseGroup);
    const ctx = createMockContext({ tenantId: 'test', errors: getReleaseGroupTool.errors });
    const input = getReleaseGroupTool.input.parse({ mbid: fullReleaseGroup.id });
    const result = await getReleaseGroupTool.handler(input, ctx);

    expect(result.title).toBe('OK Computer');
    expect(result.primaryType).toBe('Album');
    expect(result.artistCreditString).toBe('Radiohead');
    expect(result.releases).toHaveLength(2);
    expect(result.releases[0]).toMatchObject({ mbid: 'rel1', country: 'GB', status: 'Official' });
    // A small releases list under the cap carries no truncation signal.
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
  });

  it('preserves absence on a sparse payload (omitted fields stay absent, not fabricated)', async () => {
    lookupMock.mockResolvedValueOnce({
      id: 'sparse-mbid',
      title: 'Obscure Album',
    } satisfies RawReleaseGroup);
    const ctx = createMockContext({ tenantId: 'test', errors: getReleaseGroupTool.errors });
    const input = getReleaseGroupTool.input.parse({ mbid: 'sparse-mbid' });
    const result = await getReleaseGroupTool.handler(input, ctx);

    expect(result.title).toBe('Obscure Album');
    expect(result).not.toHaveProperty('primaryType');
    expect(result).not.toHaveProperty('firstReleaseDate');
    expect(result.artistCredit).toEqual([]);
    expect(result.releases).toEqual([]);
    expect(result.tags).toEqual([]);
    expect(() => getReleaseGroupTool.output.parse(result)).not.toThrow();
  });

  it('maps an upstream 400 to ctx.fail("invalid_mbid")', async () => {
    lookupMock.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ValidationError, 'Invalid mbid.'),
    );
    const ctx = createMockContext({ tenantId: 'test', errors: getReleaseGroupTool.errors });
    const input = getReleaseGroupTool.input.parse({ mbid: '0' });
    await expect(getReleaseGroupTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_mbid' },
    });
  });

  it('maps an upstream 404 to ctx.fail("entity_not_found")', async () => {
    lookupMock.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.NotFound, 'Not Found'));
    const ctx = createMockContext({ tenantId: 'test', errors: getReleaseGroupTool.errors });
    const input = getReleaseGroupTool.input.parse({ mbid: '00000000-0000-0000-0000-000000000001' });
    await expect(getReleaseGroupTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'entity_not_found' },
    });
  });

  // Regression for #2: the lookup endpoint caps embedded releases at one page
  // (live-verified 25 returned vs. 38 true total on "OK Computer"). When the
  // releases array hits the cap, the handler must surface truncation pointing
  // at browse — the same signal get_artist emits for its discography.
  it('discloses truncation when the releases list hits the one-page cap', async () => {
    const releases: RawRelease[] = Array.from({ length: 25 }, (_, i) => ({
      id: `rel${i}`,
      title: `Edition ${i}`,
    }));
    lookupMock.mockResolvedValueOnce({
      id: 'b1392450-e666-3926-a536-22c65f834433',
      title: 'Much Reissued',
      releases,
    } satisfies RawReleaseGroup);
    const ctx = createMockContext({ tenantId: 'test', errors: getReleaseGroupTool.errors });
    const input = getReleaseGroupTool.input.parse({
      mbid: 'b1392450-e666-3926-a536-22c65f834433',
    });
    await getReleaseGroupTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(25);
    expect(enrichment.cap).toBe(25);
    expect(enrichment.notice).toContain('browse_entities');
    expect(enrichment.notice).toContain('target_type=release');
  });
});

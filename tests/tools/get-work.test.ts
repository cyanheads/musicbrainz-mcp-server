/**
 * @fileoverview Tests for the get_work tool handler: full payload, sparse
 * payload (omitted upstream fields preserved as absent), error-contract mapping
 * (invalid_mbid / entity_not_found), and the regression lock that the work
 * lookup returns recording relationships unbounded — no false truncation signal
 * even when many recording-rels are present. The MusicBrainz service is mocked
 * at the accessor boundary.
 * @module tests/tools/get-work.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawRelation, RawWork } from '@/services/musicbrainz/types.js';

const lookupMock = vi.fn();

vi.mock('@/services/musicbrainz/musicbrainz-service.js', () => ({
  getMusicBrainzService: () => ({ lookup: lookupMock }),
  MusicBrainzService: class {},
}));

const { getWorkTool } = await import('@/mcp-server/tools/definitions/get-work.tool.js');

afterEach(() => lookupMock.mockReset());

const fullWork: RawWork = {
  id: 'fd1aa4f2-ba26-3a05-b72d-4392c35a073c',
  title: 'A Day in the Life',
  type: 'Song',
  languages: ['eng'],
  iswcs: ['T-010.140.236-1'],
  relations: [
    {
      type: 'composer',
      'target-type': 'artist',
      artist: { id: 'lennon', name: 'John Lennon' },
    },
    {
      type: 'performance',
      'target-type': 'recording',
      recording: { id: 'rec-canonical', title: 'A Day in the Life' },
    },
    {
      type: 'wikidata',
      'target-type': 'url',
      url: { resource: 'https://www.wikidata.org/wiki/Q477168' },
    },
  ],
};

describe('get_work', () => {
  it('maps a full payload, splitting relationships and url-rels', async () => {
    lookupMock.mockResolvedValueOnce(fullWork);
    const ctx = createMockContext({ tenantId: 'test' });
    const input = getWorkTool.input.parse({ mbid: fullWork.id });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.title).toBe('A Day in the Life');
    expect(result.type).toBe('Song');
    expect(result.languages).toEqual(['eng']);
    expect(result.iswcs).toEqual(['T-010.140.236-1']);
    // composer + recording-rel survive as relationships; the url-rel is split out.
    expect(result.relationships).toHaveLength(2);
    expect(result.relationships.map((r) => r.targetType).sort()).toEqual(['artist', 'recording']);
    expect(result.externalLinks).toEqual([
      { type: 'wikidata', resource: 'https://www.wikidata.org/wiki/Q477168' },
    ]);
  });

  it('preserves absence on a sparse payload (omitted fields stay absent, not fabricated)', async () => {
    lookupMock.mockResolvedValueOnce({
      id: 'sparse-mbid',
      title: 'Obscure Work',
    } satisfies RawWork);
    const ctx = createMockContext({ tenantId: 'test' });
    const input = getWorkTool.input.parse({ mbid: 'sparse-mbid' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.title).toBe('Obscure Work');
    expect(result).not.toHaveProperty('type');
    expect(result.languages).toEqual([]);
    expect(result.iswcs).toEqual([]);
    expect(result.aliases).toEqual([]);
    expect(result.tags).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.externalLinks).toEqual([]);
    expect(() => getWorkTool.output.parse(result)).not.toThrow();
  });

  it('maps an upstream 400 to ctx.fail("invalid_mbid")', async () => {
    lookupMock.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.InvalidParams, 'Invalid mbid.'));
    const ctx = createMockContext({ tenantId: 'test', errors: getWorkTool.errors });
    const input = getWorkTool.input.parse({ mbid: '0' });
    await expect(getWorkTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_mbid' },
    });
  });

  it('maps an upstream 404 to ctx.fail("entity_not_found")', async () => {
    lookupMock.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.NotFound, 'Not Found'));
    const ctx = createMockContext({ tenantId: 'test', errors: getWorkTool.errors });
    const input = getWorkTool.input.parse({ mbid: '00000000-0000-0000-0000-000000000001' });
    await expect(getWorkTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'entity_not_found' },
    });
  });

  // Regression for #1: the work lookup returns every recording relationship
  // unbounded (live-verified 486/486 on "A Day in the Life"). A prior guard
  // fired ctx.enrich.truncated on recordingRelCount >= 25, contradicting the
  // data it held. No truncation signal must be emitted, no matter how many
  // recording-rels come back.
  it('emits no truncation signal even with many recording relationships', async () => {
    const recordingRels: RawRelation[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'performance',
      'target-type': 'recording',
      recording: { id: `rec${i}`, title: `Recording ${i}` },
    }));
    lookupMock.mockResolvedValueOnce({
      id: 'busy-work',
      title: 'Much Recorded',
      relations: recordingRels,
    } satisfies RawWork);
    const ctx = createMockContext({ tenantId: 'test' });
    const input = getWorkTool.input.parse({ mbid: 'busy-work' });
    const result = await getWorkTool.handler(input, ctx);

    // All 100 recording-rels are surfaced...
    expect(result.relationships).toHaveLength(100);
    // ...and the enrichment surface carries no truncation claim.
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });
});

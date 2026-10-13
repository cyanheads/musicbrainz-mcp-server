/**
 * @fileoverview Tests for the get_work tool handler: full payload, sparse
 * payload (omitted upstream fields preserved as absent), error-contract mapping
 * (invalid_mbid / entity_not_found), and the regression lock that the work
 * lookup retains at most 25 recording relationships with exact totals and
 * truthful truncation disclosure. The MusicBrainz service is mocked
 * at the accessor boundary.
 * @module tests/tools/get-work.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawRelation, RawWork } from '@/services/musicbrainz/types.js';

const lookupMock = vi.fn();

vi.mock('@/services/musicbrainz/musicbrainz-service.js', () => ({
  getMusicBrainzService: () => ({ lookup: lookupMock }),
  MusicBrainzService: class {},
}));

const { getWorkTool } = await import('@/mcp-server/tools/definitions/get-work.tool.js');
const { entityResource } = await import('@/mcp-server/resources/definitions/entity.resource.js');

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
  it('keeps resource and tool slices independent of cached raw data and call order', async () => {
    const recordings = Array.from(
      { length: 26 },
      (_, i): RawRelation => ({
        'target-type': 'recording',
        type: 'performance',
        recording: { id: `r${i}`, title: `R${i}` },
      }),
    );
    const raw = {
      ...fullWork,
      relations: [fullWork.relations![0]!, ...recordings, fullWork.relations![2]!],
    };
    lookupMock.mockResolvedValue(raw);
    const resource = () =>
      entityResource.handler(
        entityResource.params!.parse({ entity_type: 'work', mbid: fullWork.id }),
        createMockContext({ errors: entityResource.errors }),
      );
    const tool = () => runToolContract(getWorkTool, { mbid: fullWork.id });
    const before = JSON.stringify(raw);
    const firstResource = await resource();
    const firstTool = await tool();
    const secondTool = await tool();
    const secondResource = await resource();
    expect(secondResource).toEqual(firstResource);
    expect(secondTool).toEqual(firstTool);
    expect(firstResource).toMatchObject({
      recordingRelationshipSummary: { totalCount: 26, truncated: true, shown: 25, cap: 25 },
    });
    expect(
      (firstResource as { relations: RawRelation[] }).relations.filter(
        (r) => r['target-type'] === 'recording',
      ),
    ).toHaveLength(25);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it('relationships disabled: no truncation or relationship-count claim', async () => {
    lookupMock.mockResolvedValueOnce(fullWork);
    const result = await runToolContract(getWorkTool, {
      mbid: fullWork.id,
      inc_relationships: false,
    });
    expect(result.structuredContent).toMatchObject({ relationships: [], externalLinks: [] });
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(result.structuredContent).not.toHaveProperty('totalCount');
  });
  it('maps a full payload, splitting relationships and url-rels', async () => {
    lookupMock.mockResolvedValueOnce(fullWork);
    const ctx = createMockContext({ tenantId: 'test', errors: getWorkTool.errors });
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
    const ctx = createMockContext({ tenantId: 'test', errors: getWorkTool.errors });
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
    lookupMock.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ValidationError, 'Invalid mbid.'),
    );
    const ctx = createMockContext({ tenantId: 'test', errors: getWorkTool.errors });
    const input = getWorkTool.input.parse({ mbid: '0' });
    await expect(getWorkTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
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

  // Regression for #1: disclosure must agree with the relationships actually returned.
  it('returns a finite recording slice with truthful disclosure on both surfaces', async () => {
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
    const ctx = createMockContext({ tenantId: 'test', errors: getWorkTool.errors });
    const input = getWorkTool.input.parse({ mbid: 'busy-work' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.relationships).toHaveLength(25);
    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({ totalCount: 100, truncated: true, shown: 25, cap: 25 });
    expect(enrichment.notice).toContain('musicbrainz_get_recording');
    expect(getWorkTool.format?.(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('Recording 24') }),
      ]),
    );
    expect(JSON.stringify(getWorkTool.format?.(result))).not.toContain('Recording 25');
  });
  it.each([0, 24, 25, 26])(
    'keeps all non-recording relationships at recording count %s',
    async (count) => {
      const recordings = Array.from(
        { length: count },
        (_, i): RawRelation => ({
          'target-type': 'recording',
          type: 'performance',
          recording: { id: `r${i}`, title: `R${i}` },
        }),
      );
      lookupMock.mockResolvedValueOnce({
        ...fullWork,
        relations: [fullWork.relations![0], ...recordings, fullWork.relations![2]],
      });
      const result = await runToolContract(getWorkTool, { mbid: fullWork.id });
      const structured = result.structuredContent as {
        relationships: { targetType: string }[];
        externalLinks: unknown[];
        totalCount: number;
        truncated?: boolean;
      };
      expect(structured.relationships).toHaveLength(Math.min(count, 25) + 1);
      expect(structured.externalLinks).toHaveLength(1);
      expect(structured.totalCount).toBe(count);
      expect(structured.truncated).toBe(count > 25 ? true : undefined);
      expect(JSON.stringify(result.content)).toContain('John Lennon');
    },
  );
});

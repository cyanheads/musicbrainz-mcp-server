/**
 * @fileoverview Recording release appearance completeness through tool and resource views.
 * @module tests/tools/get-recording.test
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawRecording } from '@/services/musicbrainz/types.js';

const lookup = vi.fn();
vi.mock('@/services/musicbrainz/musicbrainz-service.js', () => ({
  getMusicBrainzService: () => ({ lookup }),
}));
const { getRecordingTool } = await import('@/mcp-server/tools/definitions/get-recording.tool.js');
const { entityResource } = await import('@/mcp-server/resources/definitions/entity.resource.js');
const mbid = '4a7fea2e-545b-4c63-bc9a-9943cc3a29d7';
afterEach(() => lookup.mockReset());

describe('recording release appearances', () => {
  it.each([
    { size: undefined, total: undefined, completeness: 'unknown', exact: undefined },
    { size: 0, total: undefined, completeness: 'complete', exact: 0 },
    { size: 24, total: undefined, completeness: 'complete', exact: 24 },
    { size: 25, total: undefined, completeness: 'unknown', exact: undefined },
    { size: 25, total: 47, completeness: 'truncated', exact: 47 },
    { size: 25, total: 25, completeness: 'complete', exact: 25 },
    { size: 3, total: 47, completeness: 'truncated', exact: 47 },
  ])(
    'reports $completeness for size=$size total=$total without a count request',
    async ({ size, total, completeness, exact }) => {
      const raw = {
        id: mbid,
        ...(size === undefined
          ? {}
          : {
              releases: Array.from({ length: size }, (_, i) => ({
                id: `release-${i}`,
                title: `Edition ${i}`,
              })),
            }),
        ...(total === undefined ? {} : { 'release-count': total }),
      };
      const before = JSON.stringify(raw);
      lookup.mockResolvedValue(raw);
      const resource = () =>
        entityResource.handler(
          entityResource.params!.parse({ entity_type: 'recording', mbid }),
          createMockContext({ errors: entityResource.errors }),
        );
      const firstResource = await resource();
      const result = await runToolContract(getRecordingTool, { mbid });
      expect(result.isError).not.toBe(true);
      const expected = { shown: size ?? 0, cap: 25, completeness };
      expect(result.structuredContent).toMatchObject({ releaseAppearanceSummary: expected });
      const summary = (
        result.structuredContent as { releaseAppearanceSummary: Record<string, unknown> }
      ).releaseAppearanceSummary;
      if (exact === undefined) expect(summary).not.toHaveProperty('totalCount');
      else expect(summary.totalCount).toBe(exact);
      expect(summary.notice).toContain(`target_type=release, link.recording=${mbid}, offset=0`);
      const text = JSON.stringify(result.content);
      expect(text).toContain(completeness);
      expect(text).toContain(`shown: ${size ?? 0}, cap: 25`);
      expect(text).toContain(summary.notice);
      if (exact !== undefined) expect(text).toContain(`totalCount: ${exact}`);
      expect(firstResource).toMatchObject({ releaseAppearanceSummary: summary });
      expect(await resource()).toEqual(firstResource);
      expect(JSON.stringify(raw)).toBe(before);
      expect(lookup).toHaveBeenCalledTimes(3);
    },
  );
  it('retains lookup release order, metadata and relationship include flags', async () => {
    lookup.mockResolvedValue({
      id: mbid,
      title: 'Recording',
      releases: [{ id: 'second', title: 'Second', date: '2020', country: 'US' }, { id: 'first' }],
    } satisfies RawRecording);
    const result = await runToolContract(getRecordingTool, { mbid, inc_relationships: false });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      releases: [
        { mbid: 'second', title: 'Second', date: '2020', country: 'US' },
        { mbid: 'first', title: '' },
      ],
    });
    const text = JSON.stringify(result.content);
    expect(text).toMatch(/Second[\s\S]*2020[\s\S]*US[\s\S]*second[\s\S]*first/);
    expect(lookup.mock.calls[0]?.[2]).toEqual({ inc: ['artist-credits', 'releases', 'isrcs'] });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('exposes phonographic copyright credits in the enabled tool and resource lookups', async () => {
    const raw = {
      id: mbid,
      title: 'Airbag',
      relations: [
        {
          type: 'phonographic copyright',
          direction: 'backward',
          'target-type': 'label',
          label: { id: 'xl', name: 'XL Recordings Ltd.', disambiguation: 'holding company' },
          begin: '2017',
          end: '2017',
        },
        { type: 'phonographic copyright', 'target-type': 'label', label: { name: 'Sparse' } },
      ],
    } satisfies RawRecording;
    lookup.mockResolvedValue(raw);
    const result = await runToolContract(getRecordingTool, { mbid });
    expect(result.structuredContent).toMatchObject({
      relationships: [
        {
          type: 'phonographic copyright',
          direction: 'backward',
          targetType: 'label',
          targetId: 'xl',
          targetName: 'XL Recordings Ltd.',
          targetDisambiguation: 'holding company',
          begin: '2017',
          end: '2017',
        },
        { type: 'phonographic copyright', targetType: 'label', targetName: 'Sparse' },
      ],
      releaseAppearanceSummary: { completeness: 'unknown' },
    });
    expect(result.structuredContent).not.toHaveProperty('relationships.1.targetId');
    expect(JSON.stringify(result.content)).toContain(
      'XL Recordings Ltd. (xl) — holding company [2017–2017]',
    );
    expect(JSON.stringify(result.content)).toContain('label: Sparse');
    expect(lookup.mock.calls[0]?.[2].inc).toContain('label-rels');

    const resource = await entityResource.handler(
      entityResource.params!.parse({ entity_type: 'recording', mbid }),
      createMockContext({ errors: entityResource.errors }),
    );
    expect(resource).toMatchObject({ relations: raw.relations });
    expect(lookup.mock.calls[1]?.[2].inc).toContain('label-rels');
    const disabled = await runToolContract(getRecordingTool, { mbid, inc_relationships: false });
    expect(disabled.structuredContent).toMatchObject({ relationships: [], externalLinks: [] });
    expect(JSON.stringify(disabled.content)).not.toContain('phonographic copyright');
    expect(lookup.mock.calls[2]?.[2].inc).not.toContain('label-rels');
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('keeps raw release tracklists and URLs alongside edition relationship includes', async () => {
    const raw = {
      id: mbid,
      title: 'Edition',
      media: [{ tracks: [{ title: 'Track' }] }],
      relations: [
        { 'target-type': 'artist', type: 'mastering', artist: { name: 'Mastering Engineer' } },
        { 'target-type': 'label', type: 'copyright', label: { name: 'Rights Holder' } },
        {
          'target-type': 'url',
          type: 'discogs',
          url: { resource: 'https://www.discogs.com/release/1' },
        },
      ],
    };
    lookup.mockResolvedValueOnce(raw);
    const resource = await entityResource.handler(
      entityResource.params!.parse({ entity_type: 'release', mbid }),
      createMockContext({ errors: entityResource.errors }),
    );
    expect(lookup.mock.calls[0]?.[2].inc).toEqual(
      expect.arrayContaining(['artist-rels', 'label-rels', 'url-rels', 'labels', 'recordings']),
    );
    expect(resource).toEqual(raw);
  });
});

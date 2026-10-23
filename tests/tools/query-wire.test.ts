/**
 * @fileoverview Query normalization and browse error mapping through real services and fetch.
 * @module tests/tools/query-wire.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { browseEntitiesTool } from '@/mcp-server/tools/definitions/browse-entities.tool.js';
import { lookupIdentifierTool } from '@/mcp-server/tools/definitions/lookup-identifier.tool.js';
import { searchEntitiesTool } from '@/mcp-server/tools/definitions/search-entities.tool.js';
import {
  getMusicBrainzService,
  initMusicBrainzService,
  resetMusicBrainzService,
} from '@/services/musicbrainz/musicbrainz-service.js';

let http: ReturnType<typeof createFetchMock>;
let status = 200;
let count: unknown = 200;
const parent = '1834eae1-741b-3c03-9ca5-0df3decb43ea';
beforeEach(() => {
  vi.stubEnv('MUSICBRAINZ_CACHE_TTL', '0');
  vi.stubEnv('MUSICBRAINZ_MAX_RETRIES', '0');
  resetServerConfig();
  initMusicBrainzService('0.2.0');
  status = 200;
  count = 200;
  http = createFetchMock([
    {
      match: () => true,
      respond: () =>
        new Response(
          JSON.stringify({
            count,
            'release-count': count,
            artists: [{ id: parent, name: 'Radiohead', score: 100 }],
            releases: [{ id: parent, title: 'Edition' }],
            recordings: [{ id: '4a7fea2e-545b-4c63-bc9a-9943cc3a29d7', title: 'Paranoid Android' }],
            works: [{ id: 'fd1aa4f2-ba26-3a05-b72d-4392c35a073c', title: 'A Day in the Life' }],
          }),
          { status, headers: { 'Content-Type': 'application/json' } },
        ),
    },
  ]);
  http.install();
});
afterEach(() => {
  http.restore();
  resetMusicBrainzService();
  resetServerConfig();
  vi.unstubAllEnvs();
});

describe('query wire paths', () => {
  describe.each(['search', 'browse'] as const)('%s upstream totals', (mode) => {
    it('does not cache malformed totals and accepts a corrected next response', async () => {
      vi.stubEnv('MUSICBRAINZ_CACHE_TTL', '3600');
      resetServerConfig();
      initMusicBrainzService('0.2.0');
      const service = getMusicBrainzService();
      const ctx = createMockContext();
      const query = () =>
        mode === 'search'
          ? service.search('artist', 'radiohead', { limit: 25, offset: 2 }, ctx)
          : service.browse(
              'release',
              { link: 'label', linkMbid: parent, limit: 25, offset: 2 },
              ctx,
            );
      count = undefined;
      await expect(query()).rejects.toMatchObject({
        code: -32000,
        data: { reason: 'musicbrainz_malformed_response' },
      });
      expect(http.calls).toHaveLength(1);
      count = 200;
      await expect(query()).resolves.toMatchObject({
        [mode === 'search' ? 'count' : 'release-count']: 200,
      });
      expect(http.calls).toHaveLength(2);
      await expect(query()).resolves.toMatchObject({
        [mode === 'search' ? 'count' : 'release-count']: 200,
      });
      expect(http.calls).toHaveLength(2);
    });
    it.each([undefined, null, '200', -1, 1.5])(
      'rejects malformed count %s as upstream data',
      async (value) => {
        count = value;
        const result =
          mode === 'search'
            ? await runToolContract(searchEntitiesTool, {
                entityType: 'artist',
                query: 'radiohead',
                offset: 2,
              })
            : await runToolContract(browseEntitiesTool, {
                target_type: 'release',
                link: { label: parent },
                offset: 2,
              });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: -32000,
            data: {
              reason: 'musicbrainz_malformed_response',
              recovery: { hint: 'Retry this query later; MusicBrainz returned an invalid total.' },
            },
          },
        });
        expect(result.structuredContent).not.toHaveProperty('totalCount');
        expect(JSON.stringify(result.content)).toContain('nonnegative integer');
        expect(JSON.stringify(result.content)).toContain(
          'Recovery: Retry this query later; MusicBrainz returned an invalid total.',
        );
        expect(http.calls).toHaveLength(1);
      },
    );
  });
  it.each([
    ['isrc', ' GB-AYE-97-01274 ', 'GBAYE9701274', 'recordings'],
    ['iswc', ' t0101402361 ', 'T-010.140.236-1', 'works'],
  ] as const)(
    'normalizes %s before the actual service request',
    async (id_type, value, identifier, kind) => {
      const result = await runToolContract(lookupIdentifierTool, { id_type, value });
      expect(result.structuredContent).toMatchObject({ result: { identifier, kind } });
      expect(JSON.stringify(result.content)).toContain(identifier);
      expect(http.calls).toHaveLength(1);
      expect(new URL(http.calls[0]!.request.url).pathname).toBe(`/ws/2/${id_type}/${identifier}`);
    },
  );
  it('advertises identifier examples without a rejecting schema pattern', () => {
    const field = z.toJSONSchema(lookupIdentifierTool.input).properties?.value;
    expect(field).toMatchObject({
      examples: expect.arrayContaining(['T-010.140.236-1', 'GB-AYE-97-01274']),
    });
    expect(field).not.toHaveProperty('pattern');
    expect(
      lookupIdentifierTool.input.safeParse({ id_type: 'iswc', value: 'malformed' }).success,
    ).toBe(true);
  });
  it.each([400, 404, 503])('keeps supported browse pair HTTP %s truthful', async (code) => {
    status = code;
    const result = await runToolContract(browseEntitiesTool, {
      target_type: 'label',
      link: { release: parent },
    });
    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as { error: { code: number; data?: { reason?: string } } }
    ).error;
    expect(error.code).toBe(code === 400 ? -32007 : code === 404 ? -32001 : -32000);
    expect(error.data?.reason).toBe(
      code === 400 ? 'invalid_link' : code === 404 ? 'entity_not_found' : undefined,
    );
    expect(JSON.stringify(result.content)).not.toContain('Malformed');
    expect(http.calls).toHaveLength(1);
  });
  it.each(['search', 'browse'] as const)(
    'clamps %s before actual request and preserves continuation',
    async (mode) => {
      const result =
        mode === 'search'
          ? await runToolContract(searchEntitiesTool, {
              entityType: 'artist',
              query: 'radiohead',
              limit: 101,
              offset: 2,
            })
          : await runToolContract(browseEntitiesTool, {
              target_type: 'release',
              link: { label: parent },
              limit: 101,
              offset: 2,
            });
      expect(http.calls).toHaveLength(1);
      expect(new URL(http.calls[0]!.request.url).searchParams.get('limit')).toBe('100');
      expect(result.structuredContent).toMatchObject({
        notice: expect.stringContaining('offset=3'),
      });
      expect(JSON.stringify(result.content)).toContain('Requested limit 101 was clamped to 100.');
    },
  );
});

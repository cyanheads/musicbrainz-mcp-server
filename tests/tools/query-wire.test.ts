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
  it.each(['on', 'off'])(
    'preserves the oversized-limit switch %s before the search window',
    async (setting) => {
      vi.stubEnv('MUSICBRAINZ_CLAMP_OVERSIZED_LIMITS', setting);
      // The lazy limit schema resolves once per process; emulate a fresh startup.
      vi.resetModules();
      const { searchEntitiesTool: freshTool } = await import(
        '@/mcp-server/tools/definitions/search-entities.tool.js'
      );
      const { initMusicBrainzService: initialize, resetMusicBrainzService: reset } = await import(
        '@/services/musicbrainz/musicbrainz-service.js'
      );
      initialize('0.2.0');
      const result = await runToolContract(freshTool, {
        entityType: 'artist',
        query: 'radiohead',
        offset: 490,
        limit: 101,
      });
      reset();
      if (setting === 'off') {
        expect(result.structuredContent).toMatchObject({
          error: { data: { reason: 'invalid_arguments' } },
        });
        expect(http.calls).toHaveLength(0);
      } else {
        expect(new URL(http.calls[0]!.request.url).searchParams.get('limit')).toBe('10');
        expect(JSON.stringify(result.content)).toContain('clamped to 100');
        expect(JSON.stringify(result.content)).toContain('page limit to 10');
      }
    },
  );
  it('preserves query bytes and deep unfiltered browse offsets', async () => {
    const query = '  artist:"A + B" AND country:GB  ';
    await runToolContract(searchEntitiesTool, {
      entityType: 'artist',
      query,
      offset: 400,
      limit: 100,
    });
    expect(new URL(http.calls[0]!.request.url).searchParams.get('query')).toBe(query);
    await runToolContract(browseEntitiesTool, {
      target_type: 'release',
      link: { area: parent },
      offset: 800,
    });
    expect(new URL(http.calls[1]!.request.url).searchParams.get('offset')).toBe('800');
  });
  it.each([0, 400, 490, 499])('respects search window at offset %s', async (offset) => {
    count = 2000;
    const result = await runToolContract(searchEntitiesTool, {
      entityType: 'artist',
      query: ' radiohead ',
      offset,
      limit: 100,
    });
    const limit = Math.min(100, 500 - offset);
    expect(new URL(http.calls[0]!.request.url).searchParams.get('limit')).toBe(String(limit));
    expect(result.structuredContent).toMatchObject({ totalCount: 2000 });
    const text = JSON.stringify(result.content);
    if (offset === 499) {
      expect(text).toContain('500');
      expect(text).not.toContain('offset=500');
    }
    if (offset >= 490) expect(text).toContain('search window');
  });
  it.each([500, 501, 1000])('rejects search offset %s locally with recovery', async (offset) => {
    const result = await runToolContract(searchEntitiesTool, {
      entityType: 'artist',
      query: 'radiohead',
      offset,
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'search_window_exceeded',
          recovery: { hint: expect.stringContaining('musicbrainz_browse_entities') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('musicbrainz_browse_entities');
    expect(http.calls).toHaveLength(0);
  });
  it('normalizes and echoes filters on every continuation', async () => {
    for (const offset of [0, 1, 200, 201]) {
      const result = await runToolContract(browseEntitiesTool, {
        target_type: 'release',
        link: { track_artist: parent },
        type: ' Album | Live ',
        status: ' OFFICIAL | Bootleg ',
        offset,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        type: 'album|live',
        status: 'official|bootleg',
        totalCount: 200,
      });
      const text = JSON.stringify(result.content);
      expect(text).toContain('album|live');
      expect(text).toContain('official|bootleg');
      const url = new URL(http.calls.at(-1)!.request.url);
      expect(url.searchParams.get('track_artist')).toBe(parent);
      expect(url.searchParams.get('type')).toBe('album|live');
      expect(url.searchParams.get('status')).toBe('official|bootleg');
      if (offset === 0) expect(text).toContain('offset=1');
      if (offset >= 200) expect(text).not.toContain('No release');
    }
  });
  it.each([
    ['release', 'area', 'type', 'album'],
    ['release', 'area', 'status', 'official'],
    ['release', 'release-group', 'type', 'album'],
    ['release-group', 'release', 'type', 'album'],
    ['recording', 'artist', 'status', 'official'],
    ['release', 'artist', 'type', 'album||live'],
    ['release', 'artist', 'type', 'unknown'],
    ['release', 'artist', 'status', 'offical'],
  ] as const)(
    'rejects ignored or malformed %s by %s %s=%s',
    async (target_type, link, field, value) => {
      const result = await runToolContract(browseEntitiesTool, {
        target_type,
        link: { [link]: parent },
        [field]: value,
      });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_filter' } },
      });
      expect(JSON.stringify(result.content)).toContain('Recovery:');
      expect(JSON.stringify(result.content)).not.toContain('Malformed');
      expect(http.calls).toHaveLength(0);
    },
  );
  it('provides truthful area discovery recovery', async () => {
    status = 404;
    const result = await runToolContract(browseEntitiesTool, {
      target_type: 'label',
      link: { area: parent },
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: { reason: 'entity_not_found', recovery: { hint: expect.stringContaining('areaId') } },
      },
    });
    expect(JSON.stringify(result.content)).toContain('areaId');
  });
  it.each([
    [
      'type',
      'album|single|ep|broadcast|other|audio drama|audiobook|compilation|demo|dj-mix|field recording|interview|live|mixtape/street|remix|soundtrack|spokenword',
    ],
    ['status', 'official|promotion|bootleg|pseudo-release|withdrawn|cancelled'],
  ])('encodes every canonical %s token without changing pipe semantics', async (field, value) => {
    const result = await runToolContract(browseEntitiesTool, {
      target_type: 'release',
      link: { artist: parent },
      [field]: value,
    });
    expect(result.isError).not.toBe(true);
    expect(new URL(http.calls[0]!.request.url).searchParams.get(field)).toBe(value);
    expect(result.structuredContent).toHaveProperty(field, value);
    expect(JSON.stringify(result.content)).toContain(value);
  });
  it.each([
    ['release-group', 'artist', 'type', 'album|live'],
    ['release', 'artist', 'type', 'album'],
    ['release', 'label', 'type', 'album'],
    ['release', 'recording', 'type', 'album'],
    ['release', 'track_artist', 'type', 'album'],
    ['release', 'artist', 'status', 'official'],
    ['release', 'label', 'status', 'official'],
    ['release', 'recording', 'status', 'official'],
    ['release', 'release-group', 'status', 'official'],
    ['release', 'track_artist', 'status', 'official'],
  ] as const)('forwards supported %s by %s %s', async (target_type, link, field, value) => {
    // The fixture only includes release totals; release-group uses its own zero-result envelope.
    if (target_type === 'release-group') {
      http.restore();
      http = createFetchMock([
        {
          match: () => true,
          respond: () => Response.json({ 'release-group-count': 0, 'release-groups': [] }),
        },
      ]);
      http.install();
    }
    const result = await runToolContract(browseEntitiesTool, {
      target_type,
      link: { [link]: parent },
      [field]: value,
    });
    expect(result.isError).not.toBe(true);
    expect(new URL(http.calls[0]!.request.url).searchParams.get(field)).toBe(value);
    expect(result.structuredContent).toHaveProperty(field, value);
    if (target_type === 'release-group') {
      expect(result.structuredContent).toMatchObject({ totalCount: 0, entities: [] });
      expect(JSON.stringify(result.content)).toContain('No release-group');
    }
  });
  it.each(['', '   ', '\t\n'])(
    'ignores empty optional filters %j even on unsupported pairs',
    async (value) => {
      const result = await runToolContract(browseEntitiesTool, {
        target_type: 'release',
        link: { area: parent },
        type: value,
        status: value,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).not.toHaveProperty('type');
      expect(result.structuredContent).not.toHaveProperty('status');
      const url = new URL(http.calls[0]!.request.url);
      expect(url.searchParams.has('type')).toBe(false);
      expect(url.searchParams.has('status')).toBe(false);
    },
  );
  it.each(['artist', 'release-group', 'recording', 'work', 'label'] as const)(
    'rejects track_artist for %s before fetching',
    async (target_type) => {
      const result = await runToolContract(browseEntitiesTool, {
        target_type,
        link: { track_artist: parent },
      });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_link' } },
      });
      expect(http.calls).toHaveLength(0);
    },
  );
  it.each([400, 404])('maps track_artist HTTP %s as an artist parent error', async (code) => {
    status = code;
    const result = await runToolContract(browseEntitiesTool, {
      target_type: 'release',
      link: { track_artist: parent },
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: code === 400 ? 'invalid_link' : 'entity_not_found' } },
    });
    expect(JSON.stringify(result.content)).toContain('musicbrainz_get_artist');
  });
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

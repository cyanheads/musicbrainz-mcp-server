/**
 * @fileoverview get_cover_art's MBID verification on a Cover Art Archive 404,
 * tested at the HTTP seam: only `globalThis.fetch` is faked, so the real
 * CoverArtService (404 → `found: false`, cache), the real MusicBrainzService
 * (400/404 classification, per-call retry/timeout bounds), and the handler's
 * mapping all run. The archive answers 404 alike for a real entity with no art,
 * the all-zeros sentinel, and an MBID matching no entity; the WS/2 lookup of the
 * same entity type splits them (400 → invalid_mbid, 404 → entity_not_found,
 * 200 → the genuine no-art success). A failed verification never turns no-art
 * into an error — it downgrades the notice to "existence unconfirmed".
 * @module tests/tools/get-cover-art-verification.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockRoute,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { getCoverArtTool } from '@/mcp-server/tools/definitions/get-cover-art.tool.js';
import {
  initCoverArtService,
  resetCoverArtService,
} from '@/services/cover-art/cover-art-service.js';
import {
  initMusicBrainzService,
  resetMusicBrainzService,
} from '@/services/musicbrainz/musicbrainz-service.js';

const CAA = 'https://caa.test';
const WS2 = 'https://mb.test/ws/2';
const REAL_NO_ART = 'a1b2c3d4-0000-4000-8000-00000000a0a0';
const ZERO = '00000000-0000-0000-0000-000000000000';
const NONEXISTENT = '11111111-1111-4111-8111-111111111111';

/** Boot both services from env: fast limiter, one configured retry (so a bound is observable). */
function initServices(env: Record<string, string> = {}) {
  vi.stubEnv('MUSICBRAINZ_BASE_URL', WS2);
  vi.stubEnv('COVER_ART_BASE_URL', CAA);
  vi.stubEnv('MUSICBRAINZ_RATE_LIMIT_RPS', '50');
  vi.stubEnv('MUSICBRAINZ_CACHE_TTL', '0');
  vi.stubEnv('MUSICBRAINZ_MAX_RETRIES', '1');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  resetServerConfig();
  initMusicBrainzService('0.0.0-test');
  initCoverArtService();
}

const caa404 = () => new Response('<!DOCTYPE html><html>Not Found</html>', { status: 404 });
const ws2Json = (body: unknown) => Response.json(body);
const ws2Status = (status: number, error: string) => Response.json({ error }, { status });

let http: ReturnType<typeof createFetchMock> | undefined;

function install(...routes: FetchMockRoute[]) {
  http = createFetchMock(routes);
  http.install();
  return http;
}

const ws2Calls = () => (http?.calls ?? []).filter((c) => c.request.url.startsWith(WS2));
const caaCalls = () => (http?.calls ?? []).filter((c) => c.request.url.startsWith(CAA));

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;
const textOf = (r: ContractResult) =>
  (r.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
const errorOf = (r: ContractResult) =>
  (
    r.structuredContent as {
      error?: {
        code: number;
        message: string;
        data?: { reason?: string; recovery?: { hint?: string } };
      };
    }
  ).error;

beforeEach(() => initServices());

afterEach(() => {
  http?.restore();
  http = undefined;
  resetMusicBrainzService();
  resetCoverArtService();
  resetServerConfig();
  vi.unstubAllEnvs();
});

describe('get_cover_art — Cover Art Archive 404 is verified against MusicBrainz', () => {
  it('all-zeros MBID: CAA 404 + WS/2 400 → invalid_mbid on both surfaces', async () => {
    install(
      { match: `${CAA}/release/${ZERO}`, respond: caa404 },
      {
        match: (r) => r.url.startsWith(`${WS2}/release/${ZERO}`),
        respond: () => ws2Status(400, 'Invalid mbid.'),
      },
    );
    const result = await runToolContract(getCoverArtTool, { mbid: ZERO });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error?.data?.reason).toBe('invalid_mbid');
    expect(error?.data?.recovery?.hint).toContain('36-character UUID');
    expect(textOf(result)).toContain('(reason invalid_mbid');
    expect(ws2Calls()).toHaveLength(1);
  });

  it('well-formed MBID matching no entity: CAA 404 + WS/2 404 → entity_not_found on both surfaces', async () => {
    install(
      { match: `${CAA}/release/${NONEXISTENT}`, respond: caa404 },
      {
        match: (r) => r.url.startsWith(`${WS2}/release/${NONEXISTENT}`),
        respond: () => ws2Status(404, 'Not Found'),
      },
    );
    const result = await runToolContract(getCoverArtTool, { mbid: NONEXISTENT });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error?.message).toContain(`No release exists with MBID ${NONEXISTENT}`);
    expect(error?.data?.reason).toBe('entity_not_found');
    expect(error?.data?.recovery?.hint).toContain('entity_type');
    const text = textOf(result);
    expect(text).toContain('(reason entity_not_found');
    expect(text).toContain(`Recovery: ${error?.data?.recovery?.hint}`);
  });

  it('verifies against the entity type asked for (a release-group MBID sent as a release is not found)', async () => {
    install(
      { match: `${CAA}/release-group/${NONEXISTENT}`, respond: caa404 },
      {
        match: (r) => r.url.startsWith(`${WS2}/release-group/${NONEXISTENT}`),
        respond: () => ws2Status(404, 'Not Found'),
      },
    );
    const result = await runToolContract(getCoverArtTool, {
      mbid: NONEXISTENT,
      entity_type: 'release-group',
    });

    expect(errorOf(result)?.data?.reason).toBe('entity_not_found');
    expect(ws2Calls()).toHaveLength(1);
    expect(ws2Calls()[0]?.request.url).toContain(`/release-group/${NONEXISTENT}`);
  });

  it('real entity with no art: CAA 404 + WS/2 200 → the no-art success, on both surfaces', async () => {
    install(
      { match: `${CAA}/release/${REAL_NO_ART}`, respond: caa404 },
      {
        match: (r) => r.url.startsWith(`${WS2}/release/${REAL_NO_ART}`),
        respond: () => ws2Json({ id: REAL_NO_ART, title: 'Session' }),
      },
    );
    const result = await runToolContract(getCoverArtTool, { mbid: REAL_NO_ART });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      mbid: string;
      images: unknown[];
      hasArt: boolean;
      notice: string;
    };
    expect(structured.mbid).toBe(REAL_NO_ART);
    expect(structured.images).toEqual([]);
    expect(structured.hasArt).toBe(false);
    expect(structured.notice).toContain('This is not an error');
    const text = textOf(result);
    expect(text).toContain('No cover art available');
    expect(text).toContain('This is not an error');
    // The verification is a bare lookup — no inc sub-resources.
    expect(ws2Calls()).toHaveLength(1);
    expect(ws2Calls()[0]?.request.url).not.toContain('inc=');
  });

  it('verification 5xx: returns the no-art success with an "existence unconfirmed" notice after exactly one attempt', async () => {
    install(
      { match: `${CAA}/release/${REAL_NO_ART}`, respond: caa404 },
      { match: (r) => r.url.startsWith(WS2), respond: () => ws2Status(503, 'Rate limited') },
    );
    const result = await runToolContract(getCoverArtTool, { mbid: REAL_NO_ART });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      images: unknown[];
      hasArt: boolean;
      notice: string;
    };
    expect(structured.images).toEqual([]);
    expect(structured.hasArt).toBe(false);
    expect(structured.notice).toContain('could not be confirmed');
    expect(structured.notice).not.toContain('This is not an error');
    expect(textOf(result)).toContain('could not be confirmed');
    // MUSICBRAINZ_MAX_RETRIES=1 is configured; the verification lookup must not retry.
    expect(ws2Calls()).toHaveLength(1);
  });

  it('verification timeout: a stalled WS/2 lookup is cut off by the bound and reported unconfirmed', async () => {
    resetMusicBrainzService();
    resetCoverArtService();
    initServices({ MUSICBRAINZ_TIMEOUT_MS: '1000' });
    install(
      { match: `${CAA}/release/${REAL_NO_ART}`, respond: caa404 },
      {
        match: (r) => r.url.startsWith(WS2),
        respond: (request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), {
              once: true,
            });
          }),
      },
    );
    const started = Date.now();
    const result = await runToolContract(getCoverArtTool, { mbid: REAL_NO_ART });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { notice: string }).notice).toContain(
      'could not be confirmed',
    );
    expect(ws2Calls()).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 5_000);

  it('a cached CAA 404 is still verified on the next call (the cache cannot mask it)', async () => {
    resetMusicBrainzService();
    resetCoverArtService();
    initServices({ MUSICBRAINZ_CACHE_TTL: '3600' });
    install(
      { match: `${CAA}/release/${NONEXISTENT}`, respond: caa404 },
      {
        match: (r) => r.url.startsWith(`${WS2}/release/${NONEXISTENT}`),
        respond: () => ws2Status(404, 'Not Found'),
      },
    );
    // Production ctx.state is shared across requests for a tenant; share one store.
    const state = createMockContext({ tenantId: 'cache' }).state;
    const call = () =>
      getCoverArtTool.handler(getCoverArtTool.input.parse({ mbid: NONEXISTENT }), {
        ...createMockContext({ tenantId: 'cache', errors: getCoverArtTool.errors }),
        state,
      });

    await expect(call()).rejects.toMatchObject({ data: { reason: 'entity_not_found' } });
    await expect(call()).rejects.toMatchObject({ data: { reason: 'entity_not_found' } });
    expect(caaCalls()).toHaveLength(1); // second CAA answer came from the cache…
    expect(ws2Calls()).toHaveLength(2); // …and was verified again anyway
  });
});

describe('get_cover_art — no verification when the archive answers', () => {
  it('CAA 200 with images → images mapped, hasArt, no WS/2 call', async () => {
    install({
      match: `${CAA}/release/${REAL_NO_ART}`,
      respond: () =>
        Response.json({
          images: [
            {
              id: 99,
              image: 'https://caa.test/99.jpg',
              front: true,
              back: false,
              types: ['Front'],
              thumbnails: { '250': 'https://caa.test/99-250.jpg' },
            },
          ],
          release: `https://musicbrainz.org/release/${REAL_NO_ART}`,
        }),
    });
    const result = await runToolContract(getCoverArtTool, { mbid: REAL_NO_ART });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { hasArt: boolean }).hasArt).toBe(true);
    expect(textOf(result)).toContain('https://caa.test/99-250.jpg');
    expect(ws2Calls()).toHaveLength(0);
  });

  it('CAA 200 with an empty image list → no-art success, no WS/2 call', async () => {
    install({
      match: `${CAA}/release/${REAL_NO_ART}`,
      respond: () =>
        Response.json({ images: [], release: `https://musicbrainz.org/release/${REAL_NO_ART}` }),
    });
    const ctx = createMockContext({ tenantId: 't', errors: getCoverArtTool.errors });
    const output = await getCoverArtTool.handler(
      getCoverArtTool.input.parse({ mbid: REAL_NO_ART }),
      ctx,
    );

    expect(output.images).toEqual([]);
    expect(getEnrichment(ctx).hasArt).toBe(false);
    expect(getEnrichment(ctx).notice).toContain('This is not an error');
    expect(ws2Calls()).toHaveLength(0);
  });

  it('CAA 400 (not a UUID) → invalid_mbid, no WS/2 call', async () => {
    install({
      match: `${CAA}/release/not-a-uuid`,
      respond: () => new Response('bad', { status: 400 }),
    });
    const result = await runToolContract(getCoverArtTool, { mbid: 'not-a-uuid' });

    expect(errorOf(result)?.data?.reason).toBe('invalid_mbid');
    expect(ws2Calls()).toHaveLength(0);
  });
});

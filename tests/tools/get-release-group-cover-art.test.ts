/**
 * @fileoverview get_release_group's `coverArt`, tested at the HTTP seam: only
 * `globalThis.fetch` is faked, so the real MusicBrainzService, the real
 * CoverArtService (404 mapping, per-call retry/timeout bounds), and the handler
 * run. WS/2 carries no cover-art stub for release-groups, so availability comes
 * from the Cover Art Archive release-group lookup, made concurrently with the
 * WS/2 lookup; a failed archive lookup omits `coverArt` and says so in the
 * notice instead of reporting `exists: false`. Also guards get_release, whose
 * `coverArt` still comes from the WS/2 release stub with no archive call.
 * @module tests/tools/get-release-group-cover-art.test
 */

import {
  createFetchMock,
  type FetchMockRoute,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { getReleaseTool } from '@/mcp-server/tools/definitions/get-release.tool.js';
import { getReleaseGroupTool } from '@/mcp-server/tools/definitions/get-release-group.tool.js';
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
const RG = 'b1392450-e666-3926-a536-22c65f834433';

function initServices(env: Record<string, string> = {}) {
  vi.stubEnv('MUSICBRAINZ_BASE_URL', WS2);
  vi.stubEnv('COVER_ART_BASE_URL', CAA);
  vi.stubEnv('MUSICBRAINZ_RATE_LIMIT_RPS', '50');
  vi.stubEnv('MUSICBRAINZ_CACHE_TTL', '0');
  // One configured retry, so a per-call "no retries" bound is observable.
  vi.stubEnv('MUSICBRAINZ_MAX_RETRIES', '1');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  resetServerConfig();
  initMusicBrainzService('0.0.0-test');
  initCoverArtService();
}

/** WS/2 release-group payload — as live, it carries no `cover-art-archive` key. */
function rgPayload(releaseCount = 2) {
  return {
    id: RG,
    title: 'OK Computer',
    'primary-type': 'Album',
    'artist-credit': [{ name: 'Radiohead', artist: { id: 'radiohead', name: 'Radiohead' } }],
    releases: Array.from({ length: releaseCount }, (_, i) => ({
      id: `rel${i}`,
      title: `Edition ${i}`,
    })),
  };
}

const caaImages = {
  images: [
    { id: 1, image: 'https://caa.test/1.jpg', front: true, back: false, types: ['Front'] },
    { id: 2, image: 'https://caa.test/2.jpg', front: false, back: true, types: ['Back'] },
    { id: 3, image: 'https://caa.test/3.jpg', front: false, back: false, types: ['Booklet'] },
  ],
  release: 'https://musicbrainz.org/release/30702389-5c67-4438-9ea0-2351c8de0f1d',
};

let http: ReturnType<typeof createFetchMock> | undefined;

function install(...routes: FetchMockRoute[]) {
  http = createFetchMock(routes);
  http.install();
  return http;
}

const caaCalls = () => (http?.calls ?? []).filter((c) => c.request.url.startsWith(CAA));
const ws2Route = (payload: unknown) => ({
  match: (r: Request) => r.url.startsWith(`${WS2}/release-group/${RG}`),
  respond: () => Response.json(payload),
});

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;
const textOf = (r: ContractResult) =>
  (r.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');

type RgStructured = {
  coverArt?: { exists: boolean; count?: number; front?: boolean; back?: boolean };
  notice?: string;
  truncated?: boolean;
  shown?: number;
  cap?: number;
};

beforeEach(() => initServices());

afterEach(() => {
  http?.restore();
  http = undefined;
  resetMusicBrainzService();
  resetCoverArtService();
  resetServerConfig();
  vi.unstubAllEnvs();
});

describe('get_release_group — coverArt from the Cover Art Archive', () => {
  it('art present: derives exists/count/front/back from the archive images, on both surfaces', async () => {
    install(ws2Route(rgPayload()), {
      match: `${CAA}/release-group/${RG}`,
      respond: () => Response.json(caaImages),
    });
    const result = await runToolContract(getReleaseGroupTool, { mbid: RG });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as RgStructured;
    expect(structured.coverArt).toEqual({ exists: true, count: 3, front: true, back: true });
    expect(structured.notice).toBeUndefined();
    expect(textOf(result)).toContain('**Cover art:** exists: yes, count: 3, front: yes, back: yes');
    expect(caaCalls()).toHaveLength(1);
  });

  it('art absent (archive 404): reports a completed "no art" lookup, on both surfaces', async () => {
    install(ws2Route(rgPayload()), {
      match: `${CAA}/release-group/${RG}`,
      respond: () => new Response('<html>Not Found</html>', { status: 404 }),
    });
    const result = await runToolContract(getReleaseGroupTool, { mbid: RG });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as RgStructured;
    expect(structured.coverArt).toEqual({ exists: false, count: 0, front: false, back: false });
    expect(structured.notice).toBeUndefined();
    expect(textOf(result)).toContain('**Cover art:** exists: no, count: 0, front: no, back: no');
  });

  it('archive failure (503): omits coverArt and says why in the notice, after exactly one attempt', async () => {
    install(ws2Route(rgPayload()), {
      match: `${CAA}/release-group/${RG}`,
      respond: () => new Response('down', { status: 503 }),
    });
    const result = await runToolContract(getReleaseGroupTool, { mbid: RG });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as RgStructured;
    expect(structured).not.toHaveProperty('coverArt');
    expect(structured.notice).toContain('Cover-art availability could not be checked');
    const text = textOf(result);
    expect(text).toContain('Cover-art availability could not be checked');
    expect(text).not.toContain('**Cover art:**');
    expect(text).toContain('## OK Computer');
    expect(caaCalls()).toHaveLength(1);
  });

  it('archive timeout: a stalled lookup is cut off by the bound and treated as a failure', async () => {
    resetMusicBrainzService();
    resetCoverArtService();
    initServices({ MUSICBRAINZ_TIMEOUT_MS: '1000' });
    install(ws2Route(rgPayload()), {
      match: (r) => r.url.startsWith(CAA),
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const started = Date.now();
    const result = await runToolContract(getReleaseGroupTool, { mbid: RG });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('coverArt');
    expect((result.structuredContent as RgStructured).notice).toContain('could not be checked');
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 5_000);

  it('composes the truncation and archive-failure notices into one', async () => {
    install(ws2Route(rgPayload(25)), {
      match: `${CAA}/release-group/${RG}`,
      respond: () => new Response('down', { status: 503 }),
    });
    const result = await runToolContract(getReleaseGroupTool, { mbid: RG });

    const structured = result.structuredContent as RgStructured;
    expect(structured.truncated).toBe(true);
    expect(structured.shown).toBe(25);
    expect(structured.cap).toBe(25);
    expect(structured.notice).toContain('Releases capped at 25');
    expect(structured.notice).toContain('target_type=release');
    expect(structured.notice).toContain('Cover-art availability could not be checked');
    const text = textOf(result);
    expect(text).toContain('Releases capped at 25');
    expect(text).toContain('Cover-art availability could not be checked');
  });

  it('keeps the truncation notice alone when the archive lookup succeeds', async () => {
    install(ws2Route(rgPayload(25)), {
      match: `${CAA}/release-group/${RG}`,
      respond: () => Response.json(caaImages),
    });
    const result = await runToolContract(getReleaseGroupTool, { mbid: RG });

    const structured = result.structuredContent as RgStructured;
    expect(structured.notice).toContain('Releases capped at 25');
    expect(structured.notice).not.toContain('Cover-art');
    expect(structured.coverArt?.exists).toBe(true);
  });

  it('requests the archive while the WS/2 lookup is still in flight (concurrent, not serial)', async () => {
    let markArchiveRequested!: () => void;
    const archiveRequested = new Promise<void>((resolve) => {
      markArchiveRequested = resolve;
    });
    install(
      {
        match: (r) => r.url.startsWith(`${WS2}/release-group/${RG}`),
        // Answer only once the archive request has arrived; a serial handler
        // would never send it, and this responder fails after 1 s instead.
        respond: async () => {
          await Promise.race([
            archiveRequested,
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('archive not requested during WS/2 lookup')),
                1_000,
              ),
            ),
          ]);
          return Response.json(rgPayload());
        },
      },
      {
        match: `${CAA}/release-group/${RG}`,
        respond: () => {
          markArchiveRequested();
          return Response.json(caaImages);
        },
      },
    );
    const result = await runToolContract(getReleaseGroupTool, { mbid: RG });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as RgStructured).coverArt?.exists).toBe(true);
  });

  it('a WS/2 failure that lands before the archive answers leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      install(
        {
          match: (r) => r.url.startsWith(`${WS2}/release-group/`),
          respond: () => Response.json({ error: 'Invalid mbid.' }, { status: 400 }),
        },
        {
          match: (r) => r.url.startsWith(CAA),
          // The archive fails too, but only after the WS/2 400 has already thrown.
          respond: () =>
            new Promise<Response>((resolve) =>
              setTimeout(() => resolve(new Response('bad', { status: 400 })), 100),
            ),
        },
      );
      const result = await runToolContract(getReleaseGroupTool, { mbid: 'not-a-uuid' });
      expect(
        (result.structuredContent as { error?: { data?: { reason?: string } } }).error?.data
          ?.reason,
      ).toBe('invalid_mbid');

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(caaCalls()).toHaveLength(1); // the archive request did go out…
      expect(unhandled).toEqual([]); // …and its rejection was handled
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('get_release — coverArt stays the WS/2 release stub', () => {
  it('maps the release payload stub and makes no archive call', async () => {
    const RELEASE = '30702389-5c67-4438-9ea0-2351c8de0f1d';
    install({
      match: (r) => r.url.startsWith(`${WS2}/release/${RELEASE}`),
      respond: () =>
        Response.json({
          id: RELEASE,
          title: 'OK Computer',
          'cover-art-archive': {
            artwork: true,
            count: 2,
            front: true,
            back: false,
            darkened: false,
          },
        }),
    });
    const result = await runToolContract(getReleaseTool, { mbid: RELEASE });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as RgStructured).coverArt).toEqual({
      exists: true,
      count: 2,
      front: true,
      back: false,
    });
    expect(textOf(result)).toContain('**Cover art:** exists: yes, count: 2, front: yes, back: no');
    expect(caaCalls()).toHaveLength(0);
  });
});

/**
 * @fileoverview Wire-level characterization of the upstream-status → declared
 * reason mapping on the seven lookup tools. Only `globalThis.fetch` is faked, so
 * the real service (status classification, 400 → ValidationError reclassification)
 * and each handler's own mapping run end to end, and `runToolContract` renders
 * the envelope a client receives. Pins the full `structuredContent.error` —
 * code, message, and data — for an upstream 400 and 404, plus an undeclared
 * upstream failure that must bubble without a reason.
 * @module tests/tools/lookup-error-contract.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { getArtistTool } from '@/mcp-server/tools/definitions/get-artist.tool.js';
import { getLabelTool } from '@/mcp-server/tools/definitions/get-label.tool.js';
import { getRecordingTool } from '@/mcp-server/tools/definitions/get-recording.tool.js';
import { getReleaseTool } from '@/mcp-server/tools/definitions/get-release.tool.js';
import { getReleaseGroupTool } from '@/mcp-server/tools/definitions/get-release-group.tool.js';
import { getWorkTool } from '@/mcp-server/tools/definitions/get-work.tool.js';
import { lookupIdentifierTool } from '@/mcp-server/tools/definitions/lookup-identifier.tool.js';
import {
  initCoverArtService,
  resetCoverArtService,
} from '@/services/cover-art/cover-art-service.js';
import {
  initMusicBrainzService,
  resetMusicBrainzService,
} from '@/services/musicbrainz/musicbrainz-service.js';

/** Upstream status keyed by a marker the test puts in the MBID / identifier. */
const STATUS_BY_MARKER: Record<string, number> = { bad: 400, missing: 404, down: 503 };

function statusFor(url: string): number {
  if (url.includes('GBBAD9701274') || url.includes('T-000.000.001-1')) return 400;
  if (url.includes('GBMIS9701274') || url.includes('T-000.000.002-2')) return 404;
  if (url.includes('GBDWN9701274') || url.includes('T-000.000.003-3')) return 503;
  if (url.includes('33333333-3333-4333-8333-333333333333')) return 400;
  if (url.includes('11111111-1111-4111-8111-111111111111')) return 404;
  if (url.includes('22222222-2222-4222-8222-222222222222')) return 503;
  const marker = Object.keys(STATUS_BY_MARKER).find((m) => url.includes(`-${m}-`));
  return marker ? (STATUS_BY_MARKER[marker] as number) : 500;
}

let http: ReturnType<typeof createFetchMock>;

beforeAll(() => {
  // Fast limiter, no cache, no retries: one MusicBrainz request per lookup.
  vi.stubEnv('MUSICBRAINZ_RATE_LIMIT_RPS', '50');
  vi.stubEnv('MUSICBRAINZ_CACHE_TTL', '0');
  vi.stubEnv('MUSICBRAINZ_MAX_RETRIES', '0');
  resetServerConfig();
  initMusicBrainzService('0.0.0-test');
  initCoverArtService();
  http = createFetchMock([
    {
      match: () => true,
      respond: (request) => {
        const status = statusFor(request.url);
        const body = status === 400 ? '{"error":"Invalid mbid."}' : `{"error":"status ${status}"}`;
        return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
      },
    },
  ]);
  http.install();
});

afterAll(() => {
  http.restore();
  resetMusicBrainzService();
  resetCoverArtService();
  resetServerConfig();
  vi.unstubAllEnvs();
});

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

function errorOf(result: ContractResult) {
  return (result.structuredContent as { error?: { code: number; message: string; data?: unknown } })
    .error;
}

function textOf(result: ContractResult): string {
  return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

/** Contract entry for a reason, read from the definition's own errors[]. */
function entry(
  errors: readonly { reason: string; when: string; recovery: string }[],
  reason: string,
) {
  const found = errors.find((e) => e.reason === reason);
  if (!found) throw new Error(`no contract entry ${reason}`);
  return found;
}

const MBID_TOOLS = [
  ['musicbrainz_get_artist', getArtistTool],
  ['musicbrainz_get_label', getLabelTool],
  ['musicbrainz_get_recording', getRecordingTool],
  ['musicbrainz_get_release', getReleaseTool],
  ['musicbrainz_get_release_group', getReleaseGroupTool],
  ['musicbrainz_get_work', getWorkTool],
] as const;

describe('MBID lookup tools — upstream status → declared reason', () => {
  describe.each(MBID_TOOLS)('%s', (_name, def) => {
    const errors = def.errors as unknown as { reason: string; when: string; recovery: string }[];

    it.each([
      [
        '400',
        'invalid_mbid',
        JsonRpcErrorCode.ValidationError,
        '33333333-3333-4333-8333-333333333333',
      ],
      [
        '404',
        'entity_not_found',
        JsonRpcErrorCode.NotFound,
        '11111111-1111-4111-8111-111111111111',
      ],
    ] as const)(
      'maps an upstream %s to %s with the contract message, recovery, and mbid',
      async (_status, reason, code, mbid) => {
        const callsBefore = http.calls.length;
        const result = await runToolContract(def, { mbid });
        const contract = entry(errors, reason);

        expect(
          http.calls
            .slice(callsBefore)
            .filter((call) => new URL(call.request.url).pathname.startsWith('/ws/2/')),
        ).toHaveLength(1);
        expect(result.isError).toBe(true);
        expect(errorOf(result)).toEqual({
          code,
          message: contract.when,
          data: { recovery: { hint: contract.recovery }, mbid, reason },
        });
        const text = textOf(result);
        expect(text).toContain(`Error: ${contract.when}`);
        expect(text).toContain(`Recovery: ${contract.recovery}`);
        expect(text).toContain(`(reason ${reason}`);
      },
    );

    it('lets an undeclared upstream failure (503) bubble with no reason', async () => {
      const result = await runToolContract(def, {
        mbid: '22222222-2222-4222-8222-222222222222',
      });

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((error?.data as { reason?: string } | undefined)?.reason).toBeUndefined();
    });
  });
});

describe('musicbrainz_lookup_identifier — ISRC/ISWC endpoint status → declared reason', () => {
  const errors = lookupIdentifierTool.errors as unknown as {
    reason: string;
    when: string;
    recovery: string;
  }[];

  it.each([
    ['isrc', '400', 'invalid_identifier', JsonRpcErrorCode.ValidationError, 'GBBAD9701274'],
    ['isrc', '404', 'identifier_not_found', JsonRpcErrorCode.NotFound, 'GBMIS9701274'],
    ['iswc', '400', 'invalid_identifier', JsonRpcErrorCode.ValidationError, 'T-000.000.001-1'],
    ['iswc', '404', 'identifier_not_found', JsonRpcErrorCode.NotFound, 'T-000.000.002-2'],
  ] as const)('%s: maps an upstream %s to %s', async (idType, _status, reason, code, value) => {
    const result = await runToolContract(lookupIdentifierTool, { id_type: idType, value });
    const contract = entry(errors, reason);
    const message = `Identifier "${value}" — ${reason}.`;

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toEqual({
      code,
      message,
      data: { recovery: { hint: contract.recovery }, reason },
    });
    const text = textOf(result);
    expect(text).toContain(`Error: ${message}`);
    expect(text).toContain(`Recovery: ${contract.recovery}`);
    expect(text).toContain(`(reason ${reason}`);
  });

  it.each(['isrc', 'iswc'] as const)(
    '%s: lets an undeclared upstream failure (503) bubble with no reason',
    async (idType) => {
      const result = await runToolContract(lookupIdentifierTool, {
        id_type: idType,
        value: idType === 'isrc' ? 'GBDWN9701274' : 'T-000.000.003-3',
      });

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((error?.data as { reason?: string } | undefined)?.reason).toBeUndefined();
    },
  );
});

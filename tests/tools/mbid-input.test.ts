/**
 * @fileoverview Advertised MBID grammar and early typed validation through real services.
 * @module tests/tools/mbid-input.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { entityResource } from '@/mcp-server/resources/definitions/entity.resource.js';
import { browseEntitiesTool } from '@/mcp-server/tools/definitions/browse-entities.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import {
  initCoverArtService,
  resetCoverArtService,
} from '@/services/cover-art/cover-art-service.js';
import {
  initMusicBrainzService,
  resetMusicBrainzService,
} from '@/services/musicbrainz/musicbrainz-service.js';

let http: ReturnType<typeof createFetchMock>;
beforeEach(() => {
  vi.stubEnv('MUSICBRAINZ_MAX_RETRIES', '0');
  vi.stubEnv('MUSICBRAINZ_CACHE_TTL', '0');
  vi.stubEnv('MUSICBRAINZ_RATE_LIMIT_RPS', '50');
  resetServerConfig();
  initMusicBrainzService('0.1.9');
  initCoverArtService();
  http = createFetchMock([
    { match: () => true, respond: () => new Response('Not Found', { status: 404 }) },
  ]);
  http.install();
});
afterEach(() => {
  http.restore();
  resetMusicBrainzService();
  resetCoverArtService();
  resetServerConfig();
  vi.unstubAllEnvs();
});

const mbidTools = allToolDefinitions.filter((tool) => tool.name.startsWith('musicbrainz_get_'));
describe('MBID domain wiring', () => {
  it.each(mbidTools)(
    '$name rejects malformed and sentinel identifiers before fetch',
    async (tool) => {
      for (const mbid of ['not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
        const result = await runToolContract(tool, { mbid });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: { reason: 'invalid_mbid', recovery: { hint: expect.any(String) } },
          },
        });
        expect(JSON.stringify(result.content)).toContain('invalid_mbid');
      }
      expect(http.calls).toHaveLength(0);
    },
  );
  it('browse and resource retain their typed malformed-ID contracts', async () => {
    const result = await runToolContract(browseEntitiesTool, {
      target_type: 'recording',
      link: { release: 'not-a-uuid' },
    });
    expect(result.structuredContent).toMatchObject({ error: { data: { reason: 'invalid_link' } } });
    expect(JSON.stringify(result.content)).toContain('invalid_link');
    await expect(
      entityResource.handler(
        entityResource.params!.parse({ entity_type: 'work', mbid: 'not-a-uuid' }),
        createMockContext({ errors: entityResource.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_mbid' },
    });
    expect(http.calls).toHaveLength(0);
  });
  it.each(mbidTools)(
    '$name advertises broad grammar without schema-level domain refusal',
    (tool) => {
      const schema = z.toJSONSchema(tool.input);
      const field = schema.properties?.mbid;
      if (!field || typeof field === 'boolean' || typeof field.pattern !== 'string') {
        throw new Error(`${tool.name} does not advertise an MBID pattern.`);
      }
      const grammar = new RegExp(field.pattern);
      expect(grammar.test(' \nABCDEF12-ABCD-0123-0123-ABCDEF123456\t')).toBe(true);
      expect(grammar.test('00000000-0000-0000-0000-000000000000')).toBe(true);
      expect(grammar.test('{abcdef12-abcd-0123-0123-abcdef123456}')).toBe(false);
      expect(grammar.test('abcdef12abcd01230123abcdef123456')).toBe(false);
      expect(() => tool.input.parse({ mbid: 'not-a-uuid' })).not.toThrow();
    },
  );
});

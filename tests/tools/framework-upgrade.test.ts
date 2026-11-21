/** @fileoverview Framework-owned behavior at the MusicBrainz tool boundary. */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect, it, vi } from 'vitest';

import { searchEntitiesTool } from '@/mcp-server/tools/definitions/search-entities.tool.js';
import { initMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';

const query = { entityType: 'artist', query: 'radiohead' } as const;
const upstreamBody = 'upstream diagnostic body';

vi.mock('@/config/server-config.js', async (importOriginal) => {
  const { getServerConfig } = await importOriginal<typeof import('@/config/server-config.js')>();
  return { getServerConfig: () => ({ ...getServerConfig(), maxRetries: 0 }) };
});

it('keeps the upstream status and omits the response body on a search error', async () => {
  initMusicBrainzService('0.3.0');
  const http = createFetchMock([
    {
      match: (request) => new URL(request.url).pathname === '/ws/2/artist',
      respond: () => new Response(upstreamBody, { status: 503 }),
    },
  ]);
  http.install();
  try {
    const result = await runToolContract(searchEntitiesTool, query);

    expect(http.calls).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { status: 503, statusCode: 503, errorSource: 'FetchHttpError' },
      },
    });
    expect(result.structuredContent).not.toHaveProperty('error.data.body');
    expect(result.structuredContent).not.toHaveProperty('error.data.responseBody');
    expect(result.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('503'),
    });
    expect(JSON.stringify(result.content)).not.toContain(upstreamBody);
  } finally {
    http.restore();
  }
});

it('reports the minimum when a string limit can be repaired but remains out of range', async () => {
  const result = await runToolContract(searchEntitiesTool, { ...query, limit: '0' } as never);

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.InvalidParams,
      message: expect.stringContaining('limit: Too small: expected number to be >=1'),
      data: { reason: 'invalid_arguments' },
    },
  });
  expect(result.content?.[0]).toMatchObject({
    type: 'text',
    text: expect.stringContaining('limit: Too small: expected number to be >=1'),
  });
});

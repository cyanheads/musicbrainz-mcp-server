/**
 * @fileoverview Contract-boundary tests. The rest of the tool suite calls
 * handlers directly with a stubbed service, which skips argument validation and
 * the error/content rendering the client actually receives. `runToolContract`
 * drives a definition through the same `parseToolArguments` and dual-surface
 * envelope the production pipeline uses, so these pin what a caller sees:
 * argument rejections, declared contract errors, and the parity between
 * `structuredContent` and `content[]`.
 * @module tests/tools/contract-boundary.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getImagesMock = vi.fn();
const searchMock = vi.fn();
const lookupMock = vi.fn();

vi.mock('@/services/cover-art/cover-art-service.js', () => ({
  getCoverArtService: () => ({ getImages: getImagesMock }),
}));

vi.mock('@/services/musicbrainz/musicbrainz-service.js', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/musicbrainz/musicbrainz-service.js')
  >('@/services/musicbrainz/musicbrainz-service.js');
  return {
    ...actual,
    getMusicBrainzService: () => ({ search: searchMock, lookup: lookupMock }),
  };
});

const { getCoverArtTool } = await import('@/mcp-server/tools/definitions/get-cover-art.tool.js');
const { searchEntitiesTool } = await import(
  '@/mcp-server/tools/definitions/search-entities.tool.js'
);

/** The text of the first `content[]` block — the surface `content`-reading clients forward. */
function firstText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  const block = result.content?.[0];
  return block && block.type === 'text' ? block.text : '';
}

/** The `error` envelope a failed call puts on `structuredContent`. */
function errorEnvelope(result: Awaited<ReturnType<typeof runToolContract>>) {
  return (
    result.structuredContent as { error?: { code?: number; message?: string; data?: unknown } }
  )?.error;
}

afterEach(() => {
  getImagesMock.mockReset();
  searchMock.mockReset();
  lookupMock.mockReset();
});

describe('argument rejection', () => {
  it('rejects a wrong-typed argument as InvalidParams, not ValidationError', async () => {
    const result = await runToolContract(getCoverArtTool, { mbid: 123 } as never);

    expect(result.isError).toBe(true);
    // -32602. An argument rejection never reaches the handler, so it is a
    // JSON-RPC params fault rather than the -32007 a handler-thrown ZodError gets.
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorEnvelope(result)?.message).toContain('mbid');
    expect(errorEnvelope(result)?.message).toContain('musicbrainz_get_cover_art');
  });

  it('carries reason "invalid_arguments" and a schema-derived recovery hint', async () => {
    const result = await runToolContract(getCoverArtTool, { mbid: 123 } as never);
    const data = errorEnvelope(result)?.data as {
      reason?: string;
      recovery?: { hint?: string };
      issues?: unknown[];
    };

    expect(data.reason).toBe('invalid_arguments');
    expect(data.recovery?.hint).toBeTruthy();
    expect(data.issues).toBeInstanceOf(Array);
  });

  it('mirrors the recovery hint and the reason into the content[] text', async () => {
    const text = firstText(await runToolContract(getCoverArtTool, { mbid: 123 } as never));

    expect(text).toContain('mbid');
    expect(text).toContain('Recovery:');
    expect(text).toContain('(reason invalid_arguments');
  });

  it('rejects an out-of-range enum value on the tool that declares one', async () => {
    const result = await runToolContract(getCoverArtTool, {
      mbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
      entity_type: 'recording',
    } as never);

    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorEnvelope(result)?.message).toContain('entity_type');
    expect(getImagesMock).not.toHaveBeenCalled();
  });

  it('rejects a missing required field before the handler runs', async () => {
    const result = await runToolContract(searchEntitiesTool, { entityType: 'artist' } as never);

    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorEnvelope(result)?.message).toContain('query');
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe('declared contract errors', () => {
  it('renders the declared reason and recovery on both surfaces', async () => {
    getImagesMock.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ValidationError, 'upstream 400'),
    );
    const result = await runToolContract(getCoverArtTool, { mbid: '0' });

    expect(result.isError).toBe(true);
    const envelope = errorEnvelope(result);
    expect(envelope?.code).toBe(JsonRpcErrorCode.ValidationError);

    const data = envelope?.data as { reason?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('invalid_mbid');
    expect(data.recovery?.hint).toContain('musicbrainz_search_entities');

    // The text twin closes with the reason a caller branches on.
    const text = firstText(result);
    expect(text).toContain('(reason invalid_mbid');
    expect(text).toContain('Recovery:');
  });

  it('rejects a whitespace-only search query as blank_query on both surfaces, before the service', async () => {
    const result = await runToolContract(searchEntitiesTool, {
      entityType: 'artist',
      query: ' \t ',
    });

    expect(result.isError).toBe(true);
    const envelope = errorEnvelope(result);
    expect(envelope?.code).toBe(JsonRpcErrorCode.ValidationError);
    const data = envelope?.data as { reason?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('blank_query');
    expect(data.recovery?.hint).toContain('artist:radiohead');

    const text = firstText(result);
    expect(text).toContain('(reason blank_query');
    expect(text).toContain(`Recovery: ${data.recovery?.hint}`);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('does not leak the upstream request URL onto the client-facing error data', async () => {
    getImagesMock.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ValidationError, 'upstream 400'),
    );
    const result = await runToolContract(getCoverArtTool, { mbid: '0' });

    expect(errorEnvelope(result)?.data).not.toHaveProperty('url');
  });

  it('lets an undeclared upstream failure bubble with its own code', async () => {
    getImagesMock.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Cover Art Archive is degraded.'),
    );
    const result = await runToolContract(getCoverArtTool, { mbid: 'rel-mbid' });

    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((errorEnvelope(result)?.data as { reason?: string })?.reason).toBeUndefined();
  });
});

describe('success envelope parity', () => {
  it('carries the same image data on structuredContent and content[]', async () => {
    getImagesMock.mockResolvedValueOnce({
      found: true,
      images: [
        {
          id: 7,
          image: 'https://coverartarchive.org/release/rel/7.jpg',
          front: true,
          back: false,
          types: ['Front'],
          thumbnails: { '250': 'https://coverartarchive.org/release/rel/7-250.jpg' },
        },
      ],
    });
    const result = await runToolContract(getCoverArtTool, { mbid: 'rel' });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      images: { id: string; imageUrl: string; thumbnail250?: string }[];
      hasArt: boolean;
    };
    expect(structured.images[0]?.id).toBe('7');
    expect(structured.hasArt).toBe(true);

    const text = result.content
      ?.map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('https://coverartarchive.org/release/rel/7.jpg');
    expect(text).toContain('https://coverartarchive.org/release/rel/7-250.jpg');
    expect(text).toContain('hasArt');
  });

  it('reports an empty image set as a success with a notice, not an error', async () => {
    // Cover Art Archive 404, and the MBID check confirms the release exists.
    getImagesMock.mockResolvedValueOnce({ found: false, images: [] });
    lookupMock.mockResolvedValueOnce({ id: 'no-art' });
    const result = await runToolContract(getCoverArtTool, { mbid: 'no-art' });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { images: unknown[] }).images).toEqual([]);
    expect((result.structuredContent as { hasArt: boolean }).hasArt).toBe(false);

    const text = result.content
      ?.map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('No cover art');
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('reports a failed MBID check as a no-art success flagged unconfirmed, on both surfaces', async () => {
    getImagesMock.mockResolvedValueOnce({ found: false, images: [] });
    lookupMock.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'MusicBrainz is degraded.'),
    );
    const result = await runToolContract(getCoverArtTool, { mbid: 'maybe-real' });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { hasArt: boolean; notice: string };
    expect(structured.hasArt).toBe(false);
    expect(structured.notice).toContain('could not be confirmed');

    const text = result.content
      ?.map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('could not be confirmed');
    expect(text).not.toContain('This is not an error');
  });

  it('applies schema defaults to omitted optional arguments', async () => {
    searchMock.mockResolvedValueOnce({ count: 0, artists: [] });
    await runToolContract(searchEntitiesTool, { entityType: 'artist', query: 'radiohead' });

    // limit/offset defaults reach the service rather than arriving undefined.
    expect(searchMock).toHaveBeenCalledWith(
      'artist',
      'radiohead',
      { limit: 25, offset: 0 },
      expect.anything(),
      expect.anything(),
    );
  });
});

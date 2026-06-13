/**
 * @fileoverview Service for the Cover Art Archive (coverartarchive.org) — a host
 * distinct from MusicBrainz WS/2 with its own response shape and failure mode.
 * A release legitimately having no art returns HTTP 404 (with an HTML body), so
 * this service maps 404 to a clean empty image set rather than an error. Art is
 * served at the release level; a release-group MBID returns HTTP 307 redirecting
 * to the representative release's `index.json` — native `fetch` follows the
 * redirect automatically and the response shape is identical afterward.
 * @module services/cover-art/cover-art-service
 */

import { createHash } from 'node:crypto';

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  fetchWithTimeout,
  logger,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import type { CallOptions, RawCoverArtResponse } from '@/services/musicbrainz/types.js';

/** Entity types the Cover Art Archive serves images for. */
export type CoverArtEntityType = 'release' | 'release-group';

/**
 * Wraps the Cover Art Archive image-metadata endpoints. Shares nothing with the
 * MusicBrainz limiter — CAA is a different host (backed by archive.org) without
 * the ~1 req/sec MusicBrainz constraint.
 */
export class CoverArtService {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly maxRetries: number,
    private readonly cacheTtlSeconds: number,
  ) {}

  /**
   * Fetch image metadata for a release or release-group MBID. Returns an empty
   * `{ images: [] }` when the entity has no art (CAA 404) — the absence of art
   * is information, not a failure. A malformed/zero MBID still surfaces as the
   * upstream 400 (`InvalidParams`); transient 5xx is retried.
   */
  async getImages(
    entityType: CoverArtEntityType,
    mbid: string,
    ctx: Context,
    options?: CallOptions,
  ): Promise<RawCoverArtResponse> {
    const path = `/${entityType}/${mbid}`;
    // Hash the path to a `ctx.state`-safe key. The storage validator allows only
    // `[a-zA-Z0-9_.\-/]` — so a `:` separator is rejected, and a malformed MBID
    // can carry characters that would otherwise throw a generic ValidationError
    // here and pre-empt the upstream 400 → invalid_mbid. `_` joins the prefix.
    const key = `caa_${createHash('sha256').update(path).digest('hex')}`;
    if (this.cacheTtlSeconds > 0) {
      const cached = await ctx.state.get<RawCoverArtResponse>(key);
      if (cached !== null) {
        ctx.log.debug('Cover Art Archive cache hit', { path });
        return cached;
      }
    }

    const url = `${this.baseUrl}${path}`;
    const reqCtx = requestContextService.createRequestContext({
      operation: 'CoverArtRequest',
      requestId: ctx.requestId,
      ...(ctx.traceId && { traceId: ctx.traceId }),
    });

    let result: RawCoverArtResponse;
    try {
      result = await withRetry<RawCoverArtResponse>(
        async () => {
          const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
            headers: { Accept: 'application/json' },
            ...(options?.signal && { signal: options.signal }),
          });
          const text = await response.text();
          if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
            throw serviceUnavailable('Cover Art Archive returned HTML instead of JSON.', {
              reason: 'caa_html_response',
              path,
            });
          }
          return JSON.parse(text) as RawCoverArtResponse;
        },
        {
          operation: 'coverArtRequest',
          context: reqCtx,
          baseDelayMs: 1000,
          maxRetries: this.maxRetries,
          ...(options?.signal && { signal: options.signal }),
        },
      );
    } catch (error: unknown) {
      // 404 = no art for this entity. Map to an empty set, not an error.
      if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound) {
        ctx.log.debug('Cover Art Archive: no art for entity', { entityType, mbid });
        result = { images: [] };
      } else {
        throw error;
      }
    }

    if (this.cacheTtlSeconds > 0) {
      await ctx.state.set(key, result, { ttl: this.cacheTtlSeconds });
    }
    return result;
  }
}

// ─── Init / Accessor ─────────────────────────────────────────────────────────

let _service: CoverArtService | undefined;

/** Initialize the Cover Art service. Call from `setup()` in createApp. */
export function initCoverArtService(): void {
  const config = getServerConfig();
  _service = new CoverArtService(
    config.coverArtBaseUrl,
    config.timeoutMs,
    config.maxRetries,
    config.cacheTtlSeconds,
  );
  logger.info(
    'Cover Art service initialized.',
    requestContextService.createRequestContext({
      operation: 'CoverArtInit',
      baseUrl: config.coverArtBaseUrl,
    }),
  );
}

/** Get the initialized Cover Art service. Throws if not initialized. */
export function getCoverArtService(): CoverArtService {
  if (!_service) {
    throw new Error('Cover Art service not initialized — call initCoverArtService() in setup().');
  }
  return _service;
}

/** Reset the service singleton — test-only seam. */
export function resetCoverArtService(): void {
  _service = undefined;
}

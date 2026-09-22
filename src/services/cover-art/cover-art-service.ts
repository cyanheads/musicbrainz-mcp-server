/**
 * @fileoverview Service for the Cover Art Archive (coverartarchive.org) — a host
 * distinct from MusicBrainz WS/2 with its own response shape and failure mode.
 * A release legitimately having no art returns HTTP 404 (with an HTML body), so
 * this service maps 404 to an empty image set flagged `found: false` rather than
 * an error. The archive answers the same 404 for the all-zeros MBID and for a
 * well-formed MBID that matches no entity; only a syntactically invalid MBID gets
 * a 400. Art is served at the release level; a release-group MBID returns HTTP 307
 * redirecting to the representative release's `index.json` — native `fetch`
 * follows the redirect automatically and the response shape is identical afterward.
 * @module services/cover-art/cover-art-service
 */

import { createHash } from 'node:crypto';

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
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
 * Outcome of a Cover Art Archive lookup. `found: false` means the archive
 * answered HTTP 404 — it holds no image index for the MBID. That covers a real
 * entity with no art and an MBID that matches no MusicBrainz entity at all (the
 * archive cannot tell them apart); a caller that needs the difference verifies
 * the MBID against MusicBrainz. A 200 is `found: true`, whatever its image count.
 */
export interface CoverArtLookup extends RawCoverArtResponse {
  found: boolean;
}

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
   * Fetch image metadata for a release or release-group MBID. A CAA 404 returns
   * `{ images: [], found: false }` — the absence of art is information, not a
   * failure. A syntactically invalid MBID surfaces as the upstream 400
   * (`ValidationError`); transient 5xx is retried. `options.timeoutMs` /
   * `options.maxRetries` tighten the configured timeout and retry count for this
   * call only.
   */
  async getImages(
    entityType: CoverArtEntityType,
    mbid: string,
    ctx: Context,
    options?: CallOptions,
  ): Promise<CoverArtLookup> {
    const path = `/${entityType}/${mbid}`;
    // Hash the path to a `ctx.state`-safe key. The storage validator allows only
    // `[a-zA-Z0-9_.\-/]` — so a `:` separator is rejected, and a malformed MBID
    // can carry characters that would otherwise throw a generic ValidationError
    // here and pre-empt the upstream 400 → invalid_mbid. `_` joins the prefix.
    // The `v2` segment versions the cached shape: an entry written before
    // `found` existed cached a 404 as a bare `{ images: [] }`, which would read
    // back as a 200 and skip the caller's MBID verification.
    const key = `caa_v2_${createHash('sha256').update(path).digest('hex')}`;
    if (this.cacheTtlSeconds > 0) {
      const cached = await ctx.state.get<CoverArtLookup>(key);
      if (cached !== null) {
        ctx.log.debug('Cover Art Archive cache hit', { path });
        return cached;
      }
    }

    const url = `${this.baseUrl}${path}`;
    const reqCtx = requestContextService.createRequestContext({
      operation: 'CoverArtRequest',
      parentContext: ctx,
    });
    const timeoutMs = Math.min(options?.timeoutMs ?? this.timeoutMs, this.timeoutMs);
    const maxRetries = Math.min(options?.maxRetries ?? this.maxRetries, this.maxRetries);

    let result: CoverArtLookup;
    try {
      result = await withRetry<CoverArtLookup>(
        async () => {
          const response = await fetchWithTimeout(url, timeoutMs, reqCtx, {
            headers: { Accept: 'application/json' },
            expectedStatuses: [404],
            ...(options?.signal && { signal: options.signal }),
          });
          const text = await response.text();
          if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
            throw serviceUnavailable('Cover Art Archive returned HTML instead of JSON.', {
              reason: 'caa_html_response',
              path,
            });
          }
          return { ...(JSON.parse(text) as RawCoverArtResponse), found: true };
        },
        {
          operation: 'coverArtRequest',
          context: reqCtx,
          baseDelayMs: 1000,
          maxRetries,
          ...(options?.signal && { signal: options.signal }),
        },
      );
    } catch (error: unknown) {
      // 404 = no image index for this MBID. Map to an empty set, not an error.
      if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound) {
        ctx.log.debug('Cover Art Archive: no art for entity', { entityType, mbid });
        result = { images: [], found: false };
      } else if (error instanceof McpError && error.code === JsonRpcErrorCode.InvalidParams) {
        throw validationError(error.message, error.data, { cause: error });
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
      additionalContext: { baseUrl: config.coverArtBaseUrl },
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

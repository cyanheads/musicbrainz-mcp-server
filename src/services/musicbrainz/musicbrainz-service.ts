/**
 * @fileoverview High-level service for the MusicBrainz Web Service v2. Owns the
 * mandatory descriptive User-Agent, a process-wide ~1 req/sec rate limiter (so
 * concurrent tool calls serialize and never exceed MusicBrainz's per-IP ceiling),
 * a response cache keyed on the full request (MBIDs are stable, data changes
 * slowly), and `withRetry` backoff over the full fetch + parse pipeline.
 *
 * Three access modes, one method each: `search` (Lucene text → ranked MBIDs),
 * `lookup` (MBID + `inc` → one entity with linked sub-resources folded in),
 * `browse` (complete linked-set enumeration with deep pagination), plus
 * `resolveIdentifier` (ISRC/ISWC/barcode → entities). Uses the init/accessor pattern.
 * @module services/musicbrainz/musicbrainz-service
 */

import { createHash } from 'node:crypto';

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  fetchWithTimeout,
  logger,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { RateLimiter } from './rate-limiter.js';
import type {
  BrowseEnvelope,
  BrowseLink,
  CallOptions,
  EntityType,
  IsrcEnvelope,
  SearchEnvelope,
} from './types.js';

/**
 * Build a `ctx.state`-safe cache key from a request path. The storage key
 * validator allows only `[a-zA-Z0-9_.\-/]`, so neither the raw WS/2 path (which
 * carries `?`, `=`, `&`) nor a `:` namespace separator is usable. The path is
 * hashed to a stable hex digest and joined to the prefix with `_`. Same path →
 * same key, so cache hits still land; the digest is always pattern-safe and
 * fixed-length regardless of query content.
 */
function cacheKey(prefix: string, path: string): string {
  return `${prefix}_${createHash('sha256').update(path).digest('hex')}`;
}

/** Pluralized search/browse array keys, by entity type. */
const ENTITY_PLURAL: Record<EntityType, keyof SearchEnvelope & keyof BrowseEnvelope> = {
  artist: 'artists',
  'release-group': 'release-groups',
  release: 'releases',
  recording: 'recordings',
  work: 'works',
  label: 'labels',
};

export interface SearchParams {
  limit: number;
  offset: number;
}

export interface LookupParams {
  /** Pre-resolved `inc` tokens (e.g. `['release-groups', 'artist-rels']`). Empty = bare entity. */
  inc: string[];
}

export interface BrowseParams {
  limit: number;
  link: BrowseLink;
  linkMbid: string;
  offset: number;
}

/**
 * Facade over the MusicBrainz WS/2 endpoints. Every public method runs through
 * the shared rate limiter, the cache, and the retry wrapper.
 */
export class MusicBrainzService {
  private readonly userAgent: string;

  constructor(
    private readonly baseUrl: string,
    contact: string,
    version: string,
    private readonly limiter: RateLimiter,
    private readonly cacheTtlSeconds: number,
    private readonly timeoutMs: number,
    private readonly maxRetries: number,
  ) {
    this.userAgent = `musicbrainz-mcp-server/${version} ( ${contact} )`;
  }

  /** Full-text Lucene search over an entity type. Returns the raw search envelope. */
  search(
    type: EntityType,
    query: string,
    params: SearchParams,
    ctx: Context,
    options?: CallOptions,
  ): Promise<SearchEnvelope> {
    const search = new URLSearchParams({
      query,
      limit: String(params.limit),
      offset: String(params.offset),
      fmt: 'json',
    });
    return this.request<SearchEnvelope>(`/${type}?${search.toString()}`, ctx, options);
  }

  /** Look up one entity by MBID with the requested `inc` sub-resources folded in. */
  lookup<T>(
    type: EntityType,
    mbid: string,
    params: LookupParams,
    ctx: Context,
    options?: CallOptions,
  ): Promise<T> {
    const search = new URLSearchParams({ fmt: 'json' });
    if (params.inc.length > 0) search.set('inc', params.inc.join('+'));
    return this.request<T>(`/${type}/${mbid}?${search.toString()}`, ctx, options);
  }

  /** Paginate the complete set of `target` entities linked to one parent MBID. */
  browse(
    target: EntityType,
    params: BrowseParams,
    ctx: Context,
    options?: CallOptions,
  ): Promise<BrowseEnvelope> {
    const search = new URLSearchParams({
      [params.link]: params.linkMbid,
      limit: String(params.limit),
      offset: String(params.offset),
      fmt: 'json',
    });
    return this.request<BrowseEnvelope>(`/${target}?${search.toString()}`, ctx, options);
  }

  /**
   * Resolve a standard identifier to entities. ISRC and ISWC are dedicated
   * deterministic endpoints; barcode is a release search filter
   * (`?query=barcode:...`), so the caller routes that through {@link search}
   * instead. The ISRC endpoint omits artist credits by default, so request
   * `inc=artist-credits` — otherwise every recording falls back to the
   * "Unknown artist" placeholder.
   */
  resolveIsrc(value: string, ctx: Context, options?: CallOptions): Promise<IsrcEnvelope> {
    return this.request<IsrcEnvelope>(
      `/isrc/${encodeURIComponent(value)}?inc=artist-credits&fmt=json`,
      ctx,
      options,
    );
  }

  resolveIswc(value: string, ctx: Context, options?: CallOptions): Promise<BrowseEnvelope> {
    // ISWC endpoint returns a browse-style envelope: { work-count, work-offset, works[] }.
    return this.request<BrowseEnvelope>(
      `/iswc/${encodeURIComponent(value)}?fmt=json`,
      ctx,
      options,
    );
  }

  /** Pluralized array key for an entity type — for handlers reading search/browse envelopes. */
  static pluralKey(type: EntityType): keyof SearchEnvelope & keyof BrowseEnvelope {
    return ENTITY_PLURAL[type];
  }

  /**
   * Core request pipeline: cache check → rate-limited, retried fetch + parse →
   * cache store. `path` is the full WS/2 path with query string (already
   * `fmt=json`). A 400 (malformed MBID) maps to `InvalidParams` and a 404 (no
   * such entity) to `NotFound` via `fetchWithTimeout`'s status table — both
   * non-transient, so they fail fast without burning retries. A 503 / 5xx / HTML
   * error page is transient and retried.
   */
  private async request<T>(path: string, ctx: Context, options?: CallOptions): Promise<T> {
    const key = cacheKey('mb', path);
    if (this.cacheTtlSeconds > 0) {
      const cached = await ctx.state.get<T>(key);
      if (cached !== null) {
        ctx.log.debug('MusicBrainz cache hit', { path });
        return cached;
      }
    }

    const url = `${this.baseUrl}${path}`;
    const reqCtx = requestContextService.createRequestContext({
      operation: 'MusicBrainzRequest',
      requestId: ctx.requestId,
      ...(ctx.traceId && { traceId: ctx.traceId }),
    });

    const result = await withRetry<T>(
      () =>
        this.limiter.schedule(async () => {
          const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
            headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
            ...(options?.signal && { signal: options.signal }),
          });
          const text = await response.text();
          return this.parse<T>(text, path);
        }, options?.signal),
      {
        operation: 'musicbrainzRequest',
        context: reqCtx,
        baseDelayMs: 1500, // rate-limited tier — 503 carries Retry-After
        maxRetries: this.maxRetries,
        ...(options?.signal && { signal: options.signal }),
      },
    );

    if (this.cacheTtlSeconds > 0) {
      await ctx.state.set(key, result, { ttl: this.cacheTtlSeconds });
    }
    return result;
  }

  /**
   * Parse a JSON response body. MusicBrainz occasionally serves an HTML error
   * page under load with a 200 — detect it and throw transient
   * `ServiceUnavailable` (retryable) rather than a non-transient parse error.
   */
  private parse<T>(text: string, path: string): T {
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'MusicBrainz returned an HTML page instead of JSON — likely rate-limited or degraded.',
        { reason: 'musicbrainz_html_response', path },
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch (error: unknown) {
      // A non-HTML body that won't parse is rare; treat as transient (the
      // upstream may have truncated mid-response under load).
      throw serviceUnavailable(
        'MusicBrainz returned a malformed JSON response.',
        { reason: 'musicbrainz_malformed_json', path },
        { cause: error },
      );
    }
  }
}

// ─── Init / Accessor ─────────────────────────────────────────────────────────

let _service: MusicBrainzService | undefined;

/** Initialize the MusicBrainz service. Call from `setup()` in createApp. */
export function initMusicBrainzService(version: string): void {
  const config = getServerConfig();
  const limiter = new RateLimiter(config.rateLimitRps);
  _service = new MusicBrainzService(
    config.baseUrl,
    config.contact,
    version,
    limiter,
    config.cacheTtlSeconds,
    config.timeoutMs,
    config.maxRetries,
  );
  logger.info(
    'MusicBrainz service initialized.',
    requestContextService.createRequestContext({
      operation: 'MusicBrainzInit',
      baseUrl: config.baseUrl,
      rateLimitRps: config.rateLimitRps,
      cacheTtlSeconds: config.cacheTtlSeconds,
    }),
  );
}

/** Get the initialized MusicBrainz service. Throws if not initialized. */
export function getMusicBrainzService(): MusicBrainzService {
  if (!_service) {
    throw new Error(
      'MusicBrainz service not initialized — call initMusicBrainzService() in setup().',
    );
  }
  return _service;
}

/** Reset the service singleton — test-only seam. */
export function resetMusicBrainzService(): void {
  _service = undefined;
}

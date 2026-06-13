/**
 * @fileoverview Server-specific configuration for the MusicBrainz Web Service v2
 * and the Cover Art Archive. Lazy-parsed from environment variables; framework
 * config (transport, logging, auth) is owned by @cyanheads/mcp-ts-core and never
 * merged here.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Treats an unset env var (`undefined`), a set-but-empty env var (`""`), and an
 * unsubstituted MCPB placeholder (`${user_config.X}`) identically as "not set".
 * Without this, `MUSICBRAINZ_CONTACT=` would surface as a present-but-empty
 * contact instead of falling through to the schema default; the placeholder case
 * occurs when a Claude Desktop / MCPB host leaves an optional `user_config` field
 * blank and passes the literal `${user_config.X}` string through to the process.
 */
const PLACEHOLDER_PATTERN = /^\$\{[^}]+\}$/;
const emptyAsUndefined = (v: unknown) => {
  if (v === '') return;
  if (typeof v === 'string' && PLACEHOLDER_PATTERN.test(v)) return;
  return v;
};

const ServerConfigSchema = z.object({
  /**
   * Contact string (email or URL) embedded in the mandatory descriptive
   * User-Agent. MusicBrainz blocks requests without an application + contact
   * User-Agent, so a default is provided to keep the server functional out of
   * the box; operators running a hosted instance should set their own.
   */
  contact: z
    .preprocess(emptyAsUndefined, z.string())
    .default('https://github.com/cyanheads/musicbrainz-mcp-server')
    .describe('Contact (email or URL) embedded in the mandatory MusicBrainz User-Agent'),
  baseUrl: z
    .string()
    .url()
    .default('https://musicbrainz.org/ws/2')
    .describe('MusicBrainz Web Service v2 base URL (override for a private mirror or beta)'),
  coverArtBaseUrl: z
    .string()
    .url()
    .default('https://coverartarchive.org')
    .describe('Cover Art Archive base URL'),
  rateLimitRps: z.coerce
    .number()
    .min(0.1)
    .max(50)
    .default(1)
    .describe('Client-side MusicBrainz request-per-second ceiling (~1 is the documented limit)'),
  cacheTtlSeconds: z.coerce
    .number()
    .min(0)
    .max(2_592_000)
    .default(86_400)
    .describe(
      'Response cache TTL in seconds; MBIDs are stable so data changes slowly. 0 disables caching',
    ),
  timeoutMs: z.coerce
    .number()
    .min(1_000)
    .max(120_000)
    .default(30_000)
    .describe('Per-request HTTP timeout in milliseconds'),
  maxRetries: z.coerce
    .number()
    .min(0)
    .max(10)
    .default(3)
    .describe('Max retry attempts for transient upstream failures (503 / 5xx / HTML error page)'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Parse and cache server config from the environment. Lazy — never reads `process.env` at import time. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    contact: 'MUSICBRAINZ_CONTACT',
    baseUrl: 'MUSICBRAINZ_BASE_URL',
    coverArtBaseUrl: 'COVER_ART_BASE_URL',
    rateLimitRps: 'MUSICBRAINZ_RATE_LIMIT_RPS',
    cacheTtlSeconds: 'MUSICBRAINZ_CACHE_TTL',
    timeoutMs: 'MUSICBRAINZ_TIMEOUT_MS',
    maxRetries: 'MUSICBRAINZ_MAX_RETRIES',
  });
  return _config;
}

/** Reset cached config — test-only seam. */
export function resetServerConfig(): void {
  _config = undefined;
}

/**
 * @fileoverview Tests for the server config schema: defaults, env overrides,
 * numeric coercion, range rejection, and the "unset means unset" contract —
 * a blank value and an unsubstituted `${…}` MCPB placeholder must both fall
 * through to the schema default rather than landing as a literal string.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

const MB_ENV = [
  'MUSICBRAINZ_CONTACT',
  'MUSICBRAINZ_BASE_URL',
  'COVER_ART_BASE_URL',
  'MUSICBRAINZ_RATE_LIMIT_RPS',
  'MUSICBRAINZ_CACHE_TTL',
  'MUSICBRAINZ_TIMEOUT_MS',
  'MUSICBRAINZ_MAX_RETRIES',
] as const;

const DEFAULT_CONTACT = 'https://github.com/cyanheads/musicbrainz-mcp-server';

/**
 * The literal `${key}` text an MCPB or plugin host forwards when it leaves an
 * option unsubstituted. Assembled rather than written as an inline string so the
 * placeholder stays test data instead of reading as a botched template literal.
 */
const placeholder = (key: string) => `\${${key}}`;

beforeEach(() => {
  resetServerConfig();
  for (const key of MB_ENV) delete process.env[key];
});

afterEach(() => {
  for (const key of MB_ENV) delete process.env[key];
  resetServerConfig();
});

describe('getServerConfig', () => {
  it('applies every documented default when nothing is set', () => {
    expect(getServerConfig()).toEqual({
      contact: DEFAULT_CONTACT,
      baseUrl: 'https://musicbrainz.org/ws/2',
      coverArtBaseUrl: 'https://coverartarchive.org',
      rateLimitRps: 1,
      cacheTtlSeconds: 86_400,
      timeoutMs: 30_000,
      maxRetries: 3,
    });
  });

  it('reads overrides from the mapped env vars and coerces numerics', () => {
    process.env.MUSICBRAINZ_CONTACT = 'ops@example.com';
    process.env.MUSICBRAINZ_BASE_URL = 'https://beta.musicbrainz.org/ws/2';
    process.env.MUSICBRAINZ_RATE_LIMIT_RPS = '0.5';
    process.env.MUSICBRAINZ_CACHE_TTL = '0';
    process.env.MUSICBRAINZ_MAX_RETRIES = '0';

    const config = getServerConfig();
    expect(config.contact).toBe('ops@example.com');
    expect(config.baseUrl).toBe('https://beta.musicbrainz.org/ws/2');
    expect(config.rateLimitRps).toBe(0.5);
    expect(config.cacheTtlSeconds).toBe(0);
    expect(config.maxRetries).toBe(0);
  });

  it('caches the parsed config until reset', () => {
    const first = getServerConfig();
    process.env.MUSICBRAINZ_CONTACT = 'changed@example.com';
    expect(getServerConfig()).toBe(first);
    resetServerConfig();
    expect(getServerConfig().contact).toBe('changed@example.com');
  });

  /**
   * "Unset means unset" — a blank env line and an MCPB/plugin host forwarding an
   * unsubstituted `${user_config.X}` for an option the user left empty must both
   * read as absent. Otherwise the literal text becomes the User-Agent contact,
   * which MusicBrainz rejects. Normalization lives in the framework's
   * `parseEnvConfig`, so these pin the contract, not a local guard.
   */
  describe('unset means unset', () => {
    it('treats an empty string as absent and takes the default', () => {
      process.env.MUSICBRAINZ_CONTACT = '';
      expect(getServerConfig().contact).toBe(DEFAULT_CONTACT);
    });

    it('treats an unsubstituted host placeholder as absent and takes the default', () => {
      process.env.MUSICBRAINZ_CONTACT = placeholder('user_config.musicbrainz_contact');
      expect(getServerConfig().contact).toBe(DEFAULT_CONTACT);
    });

    it('falls through to the default for a blank numeric override', () => {
      process.env.MUSICBRAINZ_RATE_LIMIT_RPS = '';
      process.env.MUSICBRAINZ_CACHE_TTL = '';
      const config = getServerConfig();
      expect(config.rateLimitRps).toBe(1);
      expect(config.cacheTtlSeconds).toBe(86_400);
    });

    it('keeps a value that merely contains a placeholder rather than being one', () => {
      const contact = `ops+${placeholder('team')}@example.com`;
      process.env.MUSICBRAINZ_CONTACT = contact;
      expect(getServerConfig().contact).toBe(contact);
    });
  });

  describe('range validation', () => {
    it('rejects a rate limit above the ceiling, naming the env var', () => {
      process.env.MUSICBRAINZ_RATE_LIMIT_RPS = '500';
      expect(() => getServerConfig()).toThrow(/MUSICBRAINZ_RATE_LIMIT_RPS/);
    });

    it('rejects a timeout below the floor, naming the env var', () => {
      process.env.MUSICBRAINZ_TIMEOUT_MS = '10';
      expect(() => getServerConfig()).toThrow(/MUSICBRAINZ_TIMEOUT_MS/);
    });

    it('rejects a non-URL base URL, naming the env var', () => {
      process.env.MUSICBRAINZ_BASE_URL = 'not-a-url';
      expect(() => getServerConfig()).toThrow(/MUSICBRAINZ_BASE_URL/);
    });
  });
});

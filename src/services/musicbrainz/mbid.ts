/**
 * @fileoverview MusicBrainz identifier grammar and normalization at service boundaries.
 * @module services/musicbrainz/mbid
 */
import { validationError } from '@cyanheads/mcp-ts-core/errors';

/** Advertised grammar accepts surrounding whitespace and any hexadecimal UUID groups. */
export const MBID_PATTERN =
  '^\\s*[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\\s*$';
const MBID_SHAPE = new RegExp(MBID_PATTERN);

/** Normalize an MBID or reject malformed/all-zero input before any upstream request. */
export function normalizeMbid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!MBID_SHAPE.test(value) || normalized === '00000000-0000-0000-0000-000000000000') {
    throw validationError('MBID must be a hyphenated hexadecimal UUID and cannot be all zeros.');
  }
  return normalized;
}

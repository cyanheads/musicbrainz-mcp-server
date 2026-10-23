/**
 * @fileoverview Shared search/browse page limits and truthful continuation notices.
 * @module mcp-server/tools/definitions/_pagination
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

const clamped = createCounter(
  'musicbrainz.limit.clamped',
  'Oversized page limits clamped to the MusicBrainz maximum',
  '{calls}',
);

/** Resolve the switch after core loads .env, when the schema is first inspected. */
export const PageLimit = z
  .lazy(() => {
    parseConfig();
    const limit = z.number().int().min(1);
    return getServerConfig().clampOversizedLimits ? limit : limit.max(100);
  })
  .default(25)
  .describe(
    'Positive integer page size (default 25); values above 100 are clamped to 100 with a notice. With MUSICBRAINZ_CLAMP_OVERSIZED_LIMITS=off, maximum 100 is enforced.',
  );

/** Record the clamp once before requesting the applied page. */
export function applyPageLimit(requested: number, toolName: string, ctx: Context): number {
  const applied = Math.min(requested, 100);
  if (requested > applied) {
    ctx.log.info('MusicBrainz page limit clamped', { tool: toolName, requested, applied });
    clamped.add(1, { tool: toolName });
  }
  return applied;
}

/** Compose one notice; an empty upstream page never supplies a nonadvancing offset. */
export function pageNotice(
  total: number,
  offset: number,
  shown: number,
  requested: number,
  applied: number,
  emptyNotice: string,
): string | undefined {
  const notices: string[] = [];
  if (requested > applied) notices.push(`Requested limit ${requested} was clamped to ${applied}.`);
  if (total === 0) notices.push(emptyNotice);
  else if (shown === 0) {
    notices.push(
      offset >= total
        ? `This page is exhausted: offset=${offset} is at or beyond the total of ${total}. Request a lower offset to retrieve matches.`
        : `MusicBrainz returned an empty page at offset=${offset} despite reporting ${total} total entities. Retry later or verify the query; no advancing continuation offset is available.`,
    );
  } else if (offset + shown < total) {
    const remaining = total - offset - shown;
    notices.push(
      `${remaining} more entities remain. Call again with offset=${offset + shown} to continue paging.`,
    );
  }
  return notices.length ? notices.join(' ') : undefined;
}

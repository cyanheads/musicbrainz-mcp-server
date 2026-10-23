/**
 * @fileoverview musicbrainz_search_entities — full-text Lucene search across one
 * MusicBrainz entity type, returning ranked lightweight matches (MBID, name,
 * disambiguation, type, 0–100 relevance score). The required first step when
 * starting from a name rather than an MBID; chain the returned MBID into the
 * matching get_* tool.
 * @module mcp-server/tools/definitions/search-entities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getMusicBrainzService,
  MusicBrainzService,
} from '@/services/musicbrainz/musicbrainz-service.js';
import type {
  EntityType,
  RawArtist,
  RawLabel,
  RawRecording,
  RawRelease,
  RawReleaseGroup,
  RawWork,
} from '@/services/musicbrainz/types.js';
import { applyPageLimit, PageLimit, pageNotice } from './_pagination.js';
import { artistCreditString, formatDuration, normalizeArtistCredits, safeText } from './_shared.js';

const ENTITY_TYPES = ['artist', 'release-group', 'release', 'recording', 'work', 'label'] as const;

const ResultSchema = z
  .object({
    mbid: z
      .string()
      .describe('MusicBrainz identifier (UUID) — chain into the matching musicbrainz_get_* tool.'),
    name: z
      .string()
      .describe('Entity name (artist/label) or title (release-group/release/recording/work).'),
    score: z
      .number()
      .describe(
        'Lucene relevance score, 0–100. 100 = exact match; low scores are weak partial matches.',
      ),
    disambiguation: z
      .string()
      .optional()
      .describe('Short qualifier distinguishing same-named entities. Omitted when absent.'),
    type: z
      .string()
      .optional()
      .describe(
        'Entity subtype (artist type, release-group primary type, work type, label type). Omitted when absent.',
      ),
    artistCredit: z
      .string()
      .optional()
      .describe(
        'Credited artist string, for release-group/release/recording results. Omitted for artist/label/work.',
      ),
    status: z
      .string()
      .optional()
      .describe(
        'Release status (e.g. Official or Bootleg). Omitted for other entity types or when absent.',
      ),
    date: z
      .string()
      .optional()
      .describe(
        'First-release date (release-group) or release date (release). Omitted when absent.',
      ),
    country: z
      .string()
      .optional()
      .describe('Country code, for release/artist/label results. Omitted when absent.'),
    length: z.string().optional().describe('Recording length as m:ss. Omitted when unknown.'),
    isrcs: z
      .array(z.string())
      .optional()
      .describe('ISRCs on a recording result. Omitted when none.'),
    iswcs: z.array(z.string()).optional().describe('ISWCs on a work result. Omitted when none.'),
  })
  .describe('A ranked search hit. Type-specific fields appear only for the relevant entity type.');

function mapHit(type: EntityType, raw: unknown): z.infer<typeof ResultSchema> {
  const base = raw as RawArtist | RawLabel | RawWork | RawReleaseGroup | RawRelease | RawRecording;
  const score = typeof base.score === 'number' ? base.score : 0;
  const disambiguation = base.disambiguation?.trim();

  if (type === 'artist' || type === 'label') {
    const e = raw as RawArtist | RawLabel;
    return {
      mbid: e.id,
      name: e.name ?? '',
      score,
      ...(disambiguation ? { disambiguation } : {}),
      ...(e.type ? { type: e.type } : {}),
      ...(e.country ? { country: e.country } : {}),
    };
  }
  if (type === 'work') {
    const e = raw as RawWork;
    return {
      mbid: e.id,
      name: e.title ?? '',
      score,
      ...(disambiguation ? { disambiguation } : {}),
      ...(e.type ? { type: e.type } : {}),
      ...(e.iswcs?.length ? { iswcs: e.iswcs } : {}),
    };
  }
  if (type === 'recording') {
    const e = raw as RawRecording;
    const length = formatDuration(e.length);
    return {
      mbid: e.id,
      name: e.title ?? '',
      score,
      ...(disambiguation ? { disambiguation } : {}),
      artistCredit: artistCreditString(normalizeArtistCredits(e['artist-credit'])),
      ...(length ? { length } : {}),
      ...(e.isrcs?.length ? { isrcs: e.isrcs } : {}),
    };
  }
  // release-group | release
  const e = raw as RawReleaseGroup | RawRelease;
  const isReleaseGroup = type === 'release-group';
  const date = isReleaseGroup
    ? (e as RawReleaseGroup)['first-release-date']
    : (e as RawRelease).date;
  const primaryType = isReleaseGroup ? (e as RawReleaseGroup)['primary-type'] : undefined;
  const status = !isReleaseGroup ? (e as RawRelease).status : undefined;
  return {
    mbid: e.id,
    name: e.title ?? '',
    score,
    ...(disambiguation ? { disambiguation } : {}),
    ...(primaryType ? { type: primaryType } : {}),
    ...(status ? { status } : {}),
    artistCredit: artistCreditString(normalizeArtistCredits(e['artist-credit'])),
    ...(date ? { date } : {}),
    ...((e as RawRelease).country ? { country: (e as RawRelease).country as string } : {}),
  };
}

export const searchEntitiesTool = tool('musicbrainz_search_entities', {
  title: 'musicbrainz-mcp-server: search entities',
  description:
    'Full-text search across a MusicBrainz entity type (artist, release-group, release, recording, work, label) using a Lucene query string. Returns ranked matches with MBID, name/title, disambiguation, subtype where applicable, release status, and a 0–100 relevance score (100 = exact). Release rows use status; other entity subtypes use type. Starting point when resolving a name to an MBID — chain the returned MBID into the matching musicbrainz_get_* tool. Results are in MusicBrainz score-descending order. Supports field-scoped Lucene syntax (e.g. `artist:radiohead AND country:GB`).',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'blank_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query contains only whitespace (it is blank after trimming).',
      recovery:
        'Provide a non-blank query: a name or title (e.g. radiohead) or a field-scoped Lucene query (e.g. artist:radiohead).',
    },
  ],

  input: z.object({
    entityType: z.enum(ENTITY_TYPES).describe('Which entity type to search.'),
    query: z
      .string()
      .min(1)
      .describe(
        'Lucene query string; must contain non-whitespace text. Plain text matches names/titles; field scoping (e.g. `artist:`, `country:`, `tag:`) is supported. Sent to MusicBrainz exactly as given.',
      ),
    limit: PageLimit,
    offset: z.number().int().min(0).default(0).describe('Result offset for pagination (0-based).'),
  }),

  output: z.object({
    entityType: z.string().describe('The entity type that was searched.'),
    offset: z.number().describe('The effective zero-based result offset used for this page.'),
    results: z
      .array(ResultSchema)
      .describe('Ranked matches, in MusicBrainz score-descending order.'),
  }),

  enrichment: {
    effectiveQuery: z.string().describe('The query string as sent to MusicBrainz.'),
    totalCount: z.number().describe('Total matches upstream before the limit/offset window.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Limit clamp and pagination guidance, including zero matches, exhausted pages, and empty-page discrepancies.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_search_entities', {
      entityType: input.entityType,
      query: input.query,
    });
    // MusicBrainz rejects a blank query with a generic HTTP 400. Trimming is only
    // for this check — the query goes upstream exactly as the caller sent it.
    if (input.query.trim().length === 0) {
      throw ctx.fail('blank_query', 'The search query is blank — it contains only whitespace.');
    }
    const service = getMusicBrainzService();
    const limit = applyPageLimit(input.limit, 'musicbrainz_search_entities', ctx);
    const envelope = await service.search(
      input.entityType,
      input.query,
      { limit, offset: input.offset },
      ctx,
      { signal: ctx.signal },
    );

    const key = MusicBrainzService.pluralKey(input.entityType);
    const rawHits = (envelope[key] ?? []) as unknown[];
    const results = rawHits.map((h) => mapHit(input.entityType, h));

    ctx.enrich.echo(input.query);
    const total = envelope.count;
    ctx.enrich.total(total);
    const notice = pageNotice(
      total,
      input.offset,
      results.length,
      input.limit,
      limit,
      `No ${input.entityType} matched "${input.query}". Broaden the query, check spelling, or try a different entityType.`,
    );
    if (notice) ctx.enrich.notice(notice);

    return { entityType: input.entityType, offset: input.offset, results };
  },

  format: (result) => {
    const lines = [
      `## MusicBrainz ${result.entityType} search`,
      `**Matches:** ${result.results.length}`,
      `**Offset:** ${result.offset}`,
    ];
    for (const r of result.results) {
      lines.push(
        `\n### ${safeText(r.name)}${r.disambiguation ? ` (${safeText(r.disambiguation)})` : ''}`,
      );
      lines.push(`**MBID:** ${r.mbid} | **Score:** ${r.score}`);
      if (r.type) lines.push(`**Type:** ${safeText(r.type)}`);
      if (r.status) lines.push(`**Status:** ${safeText(r.status)}`);
      if (r.artistCredit) lines.push(`**Artist:** ${safeText(r.artistCredit)}`);
      if (r.date) lines.push(`**Date:** ${r.date}`);
      if (r.country) lines.push(`**Country:** ${r.country}`);
      if (r.length) lines.push(`**Length:** ${r.length}`);
      if (r.isrcs?.length) lines.push(`**ISRCs:** ${r.isrcs.join(', ')}`);
      if (r.iswcs?.length) lines.push(`**ISWCs:** ${r.iswcs.join(', ')}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

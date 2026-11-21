/**
 * @fileoverview musicbrainz_search_entities — full-text Lucene search across one
 * MusicBrainz entity type, returning ranked lightweight matches (MBID, name,
 * disambiguation, type, 0–100 relevance score). The required first step when
 * starting from a name rather than an MBID; chain the returned MBID into the
 * matching get_* tool or use an area MBID as a browse parent.
 * @module mcp-server/tools/definitions/search-entities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getMusicBrainzService,
  MusicBrainzService,
} from '@/services/musicbrainz/musicbrainz-service.js';
import type {
  RawAreaSearchHit,
  RawArtist,
  RawLabel,
  RawRecording,
  RawRelease,
  RawReleaseGroup,
  RawWork,
  SearchEntityType,
} from '@/services/musicbrainz/types.js';
import { applyPageLimit, PageLimit, pageNotice } from './_pagination.js';
import { artistCreditString, formatDuration, normalizeArtistCredits, safeText } from './_shared.js';
import {
  mapReleaseEdition,
  ReleaseEditionSchema,
  renderReleaseEdition,
} from './release-edition.js';

const ENTITY_TYPES = [
  'artist',
  'release-group',
  'release',
  'recording',
  'work',
  'label',
  'area',
] as const satisfies readonly SearchEntityType[];

const ResultSchema = z
  .object({
    mbid: z
      .string()
      .describe(
        'MusicBrainz identifier (UUID). Use an area MBID for musicbrainz_browse_entities link.area; otherwise use the matching musicbrainz_get_* tool.',
      ),
    name: z
      .string()
      .describe('Entity name (artist/label/area) or title (release-group/release/recording/work).'),
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
        'Entity subtype (artist, work, label or area type, or release-group primary type). Omitted when absent.',
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
    secondaryTypes: z
      .array(z.string())
      .optional()
      .describe(
        'Release-group secondary classifications, in upstream order. Omitted when empty; absence does not establish a studio album.',
      ),
    firstReleaseDate: z
      .string()
      .optional()
      .describe('Recording first-release date, possibly partial. Omitted when absent.'),
    iso3166_1: z
      .array(z.string())
      .optional()
      .describe('ISO 3166-1 codes for an area in upstream order. Omitted when empty.'),
    iso3166_2: z
      .array(z.string())
      .optional()
      .describe('ISO 3166-2 subdivision codes for an area in upstream order. Omitted when empty.'),
    iso3166_3: z
      .array(z.string())
      .optional()
      .describe('ISO 3166-3 historical codes for an area in upstream order. Omitted when empty.'),
    partOf: z
      .array(
        z
          .object({
            mbid: z.string().describe('Immediate parent area MBID.'),
            name: z.string().describe('Immediate parent area name.'),
          })
          .describe('An immediate parent area.'),
      )
      .optional()
      .describe(
        'Immediate parent areas reported by MusicBrainz, in upstream order. Omitted when none are available.',
      ),
    ...ReleaseEditionSchema.shape,
  })
  .describe('A ranked search hit. Type-specific fields appear only for the relevant entity type.');

function mapHit(type: SearchEntityType, raw: unknown): z.infer<typeof ResultSchema> {
  const base = raw as
    | RawArtist
    | RawLabel
    | RawWork
    | RawReleaseGroup
    | RawRelease
    | RawRecording
    | RawAreaSearchHit;
  const disambiguation = base.disambiguation?.trim();
  const shared = {
    mbid: base.id,
    score: typeof base.score === 'number' ? base.score : 0,
    ...(disambiguation ? { disambiguation } : {}),
  };

  if (type === 'area') {
    const area = raw as RawAreaSearchHit;
    const partOf = (area['relation-list'] ?? []).flatMap(({ relations }) =>
      (relations ?? []).flatMap((relation) =>
        relation.type === 'part of' &&
        relation.direction === 'backward' &&
        relation.area?.id &&
        relation.area.name
          ? [{ mbid: relation.area.id, name: relation.area.name }]
          : [],
      ),
    );
    return {
      ...shared,
      name: area.name ?? '',
      ...(area.type ? { type: area.type } : {}),
      ...(area['iso-3166-1-codes']?.length ? { iso3166_1: area['iso-3166-1-codes'] } : {}),
      ...(area['iso-3166-2-codes']?.length ? { iso3166_2: area['iso-3166-2-codes'] } : {}),
      ...(area['iso-3166-3-codes']?.length ? { iso3166_3: area['iso-3166-3-codes'] } : {}),
      ...(partOf.length ? { partOf } : {}),
    };
  }

  if (type === 'artist' || type === 'label') {
    const e = raw as RawArtist | RawLabel;
    return {
      ...shared,
      name: e.name ?? '',
      ...(e.type ? { type: e.type } : {}),
      ...(e.country ? { country: e.country } : {}),
    };
  }
  if (type === 'work') {
    const e = raw as RawWork;
    return {
      ...shared,
      name: e.title ?? '',
      ...(e.type ? { type: e.type } : {}),
      ...(e.iswcs?.length ? { iswcs: e.iswcs } : {}),
    };
  }
  if (type === 'recording') {
    const e = raw as RawRecording;
    const length = formatDuration(e.length);
    return {
      ...shared,
      name: e.title ?? '',
      artistCredit: artistCreditString(normalizeArtistCredits(e['artist-credit'])),
      ...(length ? { length } : {}),
      ...(e.isrcs?.length ? { isrcs: e.isrcs } : {}),
      ...(e['first-release-date'] ? { firstReleaseDate: e['first-release-date'] } : {}),
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
    ...shared,
    name: e.title ?? '',
    ...(primaryType ? { type: primaryType } : {}),
    ...(isReleaseGroup && (e as RawReleaseGroup)['secondary-types']?.length
      ? { secondaryTypes: (e as RawReleaseGroup)['secondary-types'] }
      : {}),
    ...(status ? { status } : {}),
    artistCredit: artistCreditString(normalizeArtistCredits(e['artist-credit'])),
    ...(date ? { date } : {}),
    ...((e as RawRelease).country ? { country: (e as RawRelease).country as string } : {}),
    ...(!isReleaseGroup ? mapReleaseEdition(e as RawRelease) : {}),
  };
}

export const searchEntitiesTool = tool('musicbrainz_search_entities', {
  title: 'musicbrainz-mcp-server: search entities',
  description:
    'Full-text Lucene search for artist, release-group, release, recording, work, label or area. Returns matches in MusicBrainz score-descending order, with MBIDs and type-specific metadata. Use area search (e.g. area:seattle) to resolve musicbrainz_browse_entities link.area. Area rows include ISO codes and immediate parents where available. Chain other MBIDs into the matching musicbrainz_get_* tool. Release rows include status and edition metadata where available. Release-groups include secondary types and recordings include first-release dates where available. Supports field scoping (e.g. artist:radiohead AND country:GB). Only the first 500 matches are accessible; narrow the query or browse complete linked sets.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'search_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The offset is at or beyond the 500-match search window.',
      recovery:
        'Use an offset below 500 and narrow the query, or use musicbrainz_browse_entities for complete linked sets.',
    },
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
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Result offset for pagination (0-based, below 500). A page crossing the 500-match ceiling is reduced to the remaining window.',
      ),
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
        'Limit clamp, pagination and area browse guidance, including zero matches, exhausted pages, and empty-page discrepancies.',
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
    if (input.offset >= 500) {
      throw ctx.fail(
        'search_window_exceeded',
        'MusicBrainz search exposes only the first 500 matches.',
      );
    }
    const service = getMusicBrainzService();
    const applied = applyPageLimit(input.limit, 'musicbrainz_search_entities', ctx);
    const limit = Math.min(applied, 500 - input.offset);
    const envelope = await service.search(
      input.entityType,
      input.query,
      { limit, offset: input.offset },
      ctx,
      { signal: ctx.signal },
    );

    const key = MusicBrainzService.pluralKey(input.entityType);
    const rawHits = envelope[key] ?? [];
    const results = rawHits.map((h) => mapHit(input.entityType, h));

    ctx.enrich.echo(input.query);
    const total = envelope.count;
    ctx.enrich.total(total);
    const paging = pageNotice(
      total,
      input.offset,
      results.length,
      input.limit,
      applied,
      `No ${input.entityType} matched "${input.query}". Broaden the query, check spelling, or try a different entityType.`,
      limit,
    );
    const areaBrowse =
      input.entityType === 'area' && results.length > 0
        ? 'Use a returned area MBID as link.area in musicbrainz_browse_entities.'
        : undefined;
    const notice = [paging, areaBrowse].filter(Boolean).join(' ');
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
      if (r.secondaryTypes?.length)
        lines.push(`**Secondary types:** ${r.secondaryTypes.map(safeText).join(', ')}`);
      if (r.firstReleaseDate) lines.push(`**First release date:** ${safeText(r.firstReleaseDate)}`);
      if (r.status) lines.push(`**Status:** ${safeText(r.status)}`);
      if (r.artistCredit) lines.push(`**Artist:** ${safeText(r.artistCredit)}`);
      if (r.date) lines.push(`**Date:** ${r.date}`);
      if (r.country) lines.push(`**Country:** ${r.country}`);
      if (r.length) lines.push(`**Length:** ${r.length}`);
      if (r.isrcs?.length) lines.push(`**ISRCs:** ${r.isrcs.join(', ')}`);
      if (r.iswcs?.length) lines.push(`**ISWCs:** ${r.iswcs.join(', ')}`);
      if (r.iso3166_1) lines.push(`**ISO 3166-1:** ${r.iso3166_1.map(safeText).join(', ')}`);
      if (r.iso3166_2) lines.push(`**ISO 3166-2:** ${r.iso3166_2.map(safeText).join(', ')}`);
      if (r.iso3166_3) lines.push(`**ISO 3166-3:** ${r.iso3166_3.map(safeText).join(', ')}`);
      for (const parent of r.partOf ?? []) {
        lines.push(`**Part of:** ${safeText(parent.name)} — ${parent.mbid}`);
      }
      lines.push(...renderReleaseEdition(r));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

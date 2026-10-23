/**
 * @fileoverview Shared Zod sub-schemas and pure normalizers for MusicBrainz tool
 * definitions. Relationships, artist-credits, life-spans, tags, aliases, and
 * external-link (url-rels) extraction recur across the artist / recording / work /
 * label / release tools, so the schemas and the raw→domain mappers live here once.
 *
 * Normalization preserves absence as "unknown": MusicBrainz omits fields entirely
 * (and a field can present as `null` in one mode and `false` in another), so every
 * mapper uses conditional spreads under `exactOptionalPropertyTypes` and never
 * fabricates a concrete value from missing upstream data.
 *
 * NOTE: this file holds shared schemas/helpers, not a tool definition, so it omits
 * the `.tool.ts` suffix to stay out of the definition glob.
 * @module mcp-server/tools/definitions/_shared
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { MBID_PATTERN } from '@/services/musicbrainz/mbid.js';
import type {
  RawAlias,
  RawArtistCredit,
  RawCoverArtStub,
  RawLifeSpan,
  RawRelation,
  RawTag,
} from '@/services/musicbrainz/types.js';

/**
 * Classify a service error from an MBID lookup: local malformed/all-zero rejection
 * and upstream HTTP 400 become `ValidationError`; a well-formed MBID with no
 * matching entity returns HTTP 404 (`NotFound`). Returns
 * the contract reason for those two cases, or `null` for anything else (transient
 * upstream failures bubble unchanged). Handlers branch on the result and throw
 * `ctx.fail('<literal reason>', …)` per branch: the error-contract lint rules skip
 * any definition whose `ctx.fail` takes a non-literal reason.
 */
export function classifyMbidError(error: unknown): 'invalid_mbid' | 'entity_not_found' | null {
  if (!(error instanceof McpError)) return null;
  if (error.code === JsonRpcErrorCode.ValidationError) return 'invalid_mbid';
  if (error.code === JsonRpcErrorCode.NotFound) return 'entity_not_found';
  return null;
}

/** Example MusicBrainz identifier used in recovery hints. */
export const MBID_EXAMPLE = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';

/** Discovery-only pattern; service validation preserves the typed domain error contract. */
export const MbidInput = z.string().meta({ pattern: MBID_PATTERN });

// ─── Zod sub-schemas (described, including nested array-item objects) ─────────

export const MbidScore = z.number().describe('Lucene relevance score, 0–100 (100 = exact match).');

export const ArtistCreditSchema = z
  .object({
    name: z.string().describe('Credited name as it appears on the release (may be an alias).'),
    artistId: z.string().describe('MBID of the credited artist — chain to musicbrainz_get_artist.'),
    artistName: z.string().describe('Canonical artist name.'),
    joinPhrase: z
      .string()
      .optional()
      .describe(
        'Text that joins this credit to the next (e.g. " feat. ", " & "). Omitted when empty.',
      ),
  })
  .describe('One credited artist within an artist credit.');

export const LifeSpanSchema = z
  .object({
    begin: z
      .string()
      .optional()
      .describe('Start date (YYYY, YYYY-MM, or YYYY-MM-DD). Omitted when unknown.'),
    end: z.string().optional().describe('End date. Omitted when unknown.'),
    ended: z
      .boolean()
      .optional()
      .describe('Whether the entity has ended. Omitted when the upstream value is unknown/null.'),
  })
  .describe('Begin/end date span. Fields omitted when MusicBrainz does not provide them.');

export const TagSchema = z
  .object({
    name: z.string().describe('Tag or genre name.'),
    count: z.number().describe('Community vote count for this tag.'),
  })
  .describe('A folksonomy tag or genre with its vote count.');

export const AliasSchema = z
  .object({
    name: z.string().describe('Alias name.'),
    sortName: z.string().optional().describe('Sortable form of the alias. Omitted when absent.'),
    type: z
      .string()
      .optional()
      .describe('Alias type (e.g. "Artist name", "Legal name"). Omitted when absent.'),
    locale: z.string().optional().describe('BCP-47 locale of the alias. Omitted when absent.'),
    primary: z
      .boolean()
      .optional()
      .describe('Whether this is the primary alias for its locale. Omitted when absent.'),
  })
  .describe('An alternate name for the entity.');

export const RelationSchema = z
  .object({
    type: z
      .string()
      .describe('Relationship role (e.g. "member of band", "producer", "writer", "performance").'),
    direction: z
      .string()
      .optional()
      .describe('Relationship direction ("forward" | "backward"). Omitted when absent.'),
    attributes: z
      .array(z.string())
      .optional()
      .describe('Role modifiers (e.g. "lead vocals", "assistant", "co"). Omitted when none.'),
    targetType: z
      .string()
      .describe('Type of the related entity ("artist" | "work" | "recording" | "label" | "url").'),
    targetId: z
      .string()
      .optional()
      .describe(
        'MBID of the related entity — chain to the matching get_* tool. Omitted for url targets.',
      ),
    targetName: z
      .string()
      .optional()
      .describe('Name/title of the related entity. Omitted when absent.'),
    targetDisambiguation: z
      .string()
      .optional()
      .describe('Qualifier distinguishing the related entity from namesakes. Omitted when absent.'),
    orderingKey: z
      .number()
      .optional()
      .describe(
        'Upstream relationship sequence key, including zero. Omitted when unknown; array order is preserved.',
      ),
    begin: z.string().optional().describe('Relationship start date. Omitted when absent.'),
    end: z.string().optional().describe('Relationship end date. Omitted when absent.'),
  })
  .describe('A typed relationship to another entity (band membership, performer, writer, etc.).');

export const ExternalLinkSchema = z
  .object({
    type: z
      .string()
      .describe('Link type (e.g. "wikidata", "discogs", "official homepage", "streaming").'),
    resource: z
      .string()
      .describe(
        'The external URL. Wikidata/Discogs IDs live in the URL path — chain to those servers.',
      ),
  })
  .describe(
    'An external resource link (url-rel). Where cross-service IDs like Wikidata QID are surfaced.',
  );

export const CoverArtStubSchema = z
  .object({
    exists: z.boolean().describe('Whether the Cover Art Archive has any artwork for this entity.'),
    count: z.number().optional().describe('Number of images available. Omitted when unknown.'),
    front: z
      .boolean()
      .optional()
      .describe('Whether a designated front image exists. Omitted when unknown.'),
    back: z
      .boolean()
      .optional()
      .describe('Whether a designated back image exists. Omitted when unknown.'),
  })
  .describe(
    'Cover-art availability summary (each tool states its source: the WS/2 release record for releases, the Cover Art Archive for release-groups) — use musicbrainz_get_cover_art for image URLs.',
  );

// ─── Pure normalizers (raw upstream → domain, absence-preserving) ─────────────

export function normalizeArtistCredits(
  credits: RawArtistCredit[] | undefined,
): z.infer<typeof ArtistCreditSchema>[] {
  if (!credits?.length) return [];
  const out: z.infer<typeof ArtistCreditSchema>[] = [];
  for (const c of credits) {
    const artistId = c.artist?.id;
    if (!artistId) continue;
    const joinPhrase = c.joinphrase;
    out.push({
      name: c.name ?? c.artist?.name ?? '',
      artistId,
      artistName: c.artist?.name ?? c.name ?? '',
      ...(joinPhrase ? { joinPhrase } : {}),
    });
  }
  return out;
}

/** Render an artist-credit array to its display string, stitching join phrases. */
export function artistCreditString(credits: z.infer<typeof ArtistCreditSchema>[]): string {
  return credits.map((c) => `${c.name}${c.joinPhrase ?? ''}`).join('') || 'Unknown artist';
}

/**
 * Render the artist-credit array as a detail block surfacing every sub-field
 * (credited name, canonical name, MBID, join phrase) — used by tools that expose
 * `artistCredit` as a full array in output, so format() stays parity-complete.
 */
export function renderArtistCredits(credits: z.infer<typeof ArtistCreditSchema>[]): string[] {
  if (credits.length === 0) return [];
  const lines = ['', '### Artist credit'];
  for (const c of credits) {
    const credited =
      c.name && c.name !== c.artistName ? ` (credited as ${safeText(`"${c.name}"`)})` : '';
    const join = c.joinPhrase ? ` + join ${safeText(`"${c.joinPhrase}"`)}` : '';
    lines.push(`- ${safeText(c.artistName)}${credited} — ${c.artistId}${join}`);
  }
  return lines;
}

export function normalizeLifeSpan(
  span: RawLifeSpan | null | undefined,
): z.infer<typeof LifeSpanSchema> | undefined {
  if (!span) return;
  const result: z.infer<typeof LifeSpanSchema> = {
    ...(span.begin ? { begin: span.begin } : {}),
    ...(span.end ? { end: span.end } : {}),
    ...(typeof span.ended === 'boolean' ? { ended: span.ended } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizeTags(tags: RawTag[] | undefined): z.infer<typeof TagSchema>[] {
  if (!tags?.length) return [];
  return tags
    .filter((t): t is RawTag & { name: string } => typeof t.name === 'string' && t.name.length > 0)
    .map((t) => ({ name: t.name, count: typeof t.count === 'number' ? t.count : 0 }));
}

export function normalizeAliases(aliases: RawAlias[] | undefined): z.infer<typeof AliasSchema>[] {
  if (!aliases?.length) return [];
  const out: z.infer<typeof AliasSchema>[] = [];
  for (const a of aliases) {
    if (!a.name) continue;
    out.push({
      name: a.name,
      ...(a['sort-name'] ? { sortName: a['sort-name'] } : {}),
      ...(a.type ? { type: a.type } : {}),
      ...(a.locale ? { locale: a.locale } : {}),
      ...(typeof a.primary === 'boolean' ? { primary: a.primary } : {}),
    });
  }
  return out;
}

/** The MBID-bearing target nested in a relation, by target-type. */
function relationTarget(rel: RawRelation): { id?: string; name?: string; disambiguation?: string } {
  switch (rel['target-type']) {
    case 'artist':
      return {
        ...(rel.artist?.id && { id: rel.artist.id }),
        ...(rel.artist?.name && { name: rel.artist.name }),
        ...(rel.artist?.disambiguation && { disambiguation: rel.artist.disambiguation }),
      };
    case 'work':
      return {
        ...(rel.work?.id && { id: rel.work.id }),
        ...(rel.work?.title && { name: rel.work.title }),
        ...(rel.work?.disambiguation && { disambiguation: rel.work.disambiguation }),
      };
    case 'recording':
      return {
        ...(rel.recording?.id && { id: rel.recording.id }),
        ...(rel.recording?.title && { name: rel.recording.title }),
        ...(rel.recording?.disambiguation && { disambiguation: rel.recording.disambiguation }),
      };
    case 'label':
      return {
        ...(rel.label?.id && { id: rel.label.id }),
        ...(rel.label?.name && { name: rel.label.name }),
        ...(rel.label?.disambiguation && { disambiguation: rel.label.disambiguation }),
      };
    default:
      return {};
  }
}

/**
 * Split a raw `relations[]` array into the non-URL relationships (band
 * membership, performers, writers, etc.) and the external links (url-rels).
 * URL relations are where cross-service IDs (Wikidata, Discogs) live, so they
 * get their own typed view.
 */
export function normalizeRelations(relations: RawRelation[] | undefined): {
  relationships: z.infer<typeof RelationSchema>[];
  externalLinks: z.infer<typeof ExternalLinkSchema>[];
} {
  const relationships: z.infer<typeof RelationSchema>[] = [];
  const externalLinks: z.infer<typeof ExternalLinkSchema>[] = [];
  if (!relations?.length) return { relationships, externalLinks };

  for (const rel of relations) {
    if (rel['target-type'] === 'url') {
      const resource = rel.url?.resource;
      if (resource) externalLinks.push({ type: rel.type ?? 'url', resource });
      continue;
    }
    const target = relationTarget(rel);
    const attributes = rel.attributes?.filter((a) => a.length > 0);
    relationships.push({
      type: rel.type ?? 'related',
      ...(rel.direction ? { direction: rel.direction } : {}),
      ...(attributes?.length ? { attributes } : {}),
      targetType: rel['target-type'] ?? 'unknown',
      ...(target.id ? { targetId: target.id } : {}),
      ...(target.name ? { targetName: target.name } : {}),
      ...(target.disambiguation ? { targetDisambiguation: target.disambiguation } : {}),
      ...(typeof rel['ordering-key'] === 'number' ? { orderingKey: rel['ordering-key'] } : {}),
      ...(rel.begin ? { begin: rel.begin } : {}),
      ...(rel.end ? { end: rel.end } : {}),
    });
  }
  return { relationships, externalLinks };
}

export function normalizeCoverArtStub(
  stub: RawCoverArtStub | undefined,
): z.infer<typeof CoverArtStubSchema> {
  if (!stub) return { exists: false };
  return {
    exists: stub.artwork === true || (typeof stub.count === 'number' && stub.count > 0),
    ...(typeof stub.count === 'number' ? { count: stub.count } : {}),
    ...(typeof stub.front === 'boolean' ? { front: stub.front } : {}),
    ...(typeof stub.back === 'boolean' ? { back: stub.back } : {}),
  };
}

/** Format milliseconds as `m:ss` (track lengths are in ms upstream). */
export function formatDuration(ms: number | null | undefined): string | undefined {
  if (typeof ms !== 'number' || ms <= 0) return;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// ─── Shared rendering helpers for format() ────────────────────────────────────
//
// These render EVERY sub-field of the schemas above so format()'s markdown stays
// content-complete with structuredContent (lint-enforced format-parity). Each
// terminal field of an object/array in `output` must appear in the rendered text.

/**
 * Neutralize a community-edited free-text value before it is interpolated into a
 * single line of `format()` markdown. Collapse controls and escape syntax that
 * would alter literal prose or interfere with adjacent server-authored delimiters.
 * Intraword underscores and less-than comparisons remain unchanged. Structured
 * values remain raw; this helper preserves presentation, not content trust.
 */
const CONTROL_OR_LINE_SEPARATOR = /[\p{Cc}\u2028\u2029]+/gu;
export function safeText(value: string): string {
  return value
    .replace(CONTROL_OR_LINE_SEPARATOR, ' ')
    .trim()
    .replace(/[\\*`[\]~&]/g, '\\$&')
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_')
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/^([#>+-])/, '\\$1');
}

/** Keep URL bytes copyable while confining the value to a single rendered line. */
export function safeUrl(value: string): string {
  return value.replace(CONTROL_OR_LINE_SEPARATOR, ' ').trim();
}

export function renderRelationships(rels: z.infer<typeof RelationSchema>[]): string[] {
  if (rels.length === 0) return [];
  const lines = ['', '### Relationships'];
  for (const r of rels) {
    const attrs = r.attributes?.length ? ` (${r.attributes.map(safeText).join(', ')})` : '';
    const target = safeText(r.targetName ?? r.targetId ?? r.targetType);
    const dir = r.direction ? ` ${r.direction}` : '';
    const dates = r.begin || r.end ? ` [${r.begin ?? ''}${r.end ? `–${r.end}` : ''}]` : '';
    const qualifier = r.targetDisambiguation ? ` — ${safeText(r.targetDisambiguation)}` : '';
    const ordering = typeof r.orderingKey === 'number' ? ` [ordering key: ${r.orderingKey}]` : '';
    lines.push(
      `- **${safeText(r.type)}**${attrs}${dir} → ${r.targetType}: ${target}${r.targetId ? ` (${r.targetId})` : ''}${qualifier}${dates}${ordering}`,
    );
  }
  return lines;
}

export function renderExternalLinks(links: z.infer<typeof ExternalLinkSchema>[]): string[] {
  if (links.length === 0) return [];
  const lines = ['', '### External links'];
  for (const l of links) lines.push(`- **${safeText(l.type)}:** ${safeUrl(l.resource)}`);
  return lines;
}

export function renderTags(tags: z.infer<typeof TagSchema>[]): string | undefined {
  if (tags.length === 0) return;
  return `**Tags/genres:** ${tags.map((t) => `${safeText(t.name)} (${t.count})`).join(', ')}`;
}

export function renderAliases(aliases: z.infer<typeof AliasSchema>[]): string | undefined {
  if (aliases.length === 0) return;
  const parts = aliases.map((a) => {
    const meta = [
      a.type ? safeText(a.type) : null,
      a.locale ? safeText(a.locale) : null,
      a.sortName && a.sortName !== a.name ? `sort: ${safeText(a.sortName)}` : null,
      typeof a.primary === 'boolean' ? `primary: ${a.primary ? 'yes' : 'no'}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return `${safeText(a.name)}${meta ? ` [${meta}]` : ''}`;
  });
  return `**Aliases:** ${parts.join('; ')}`;
}

export function renderLifeSpan(
  span: z.infer<typeof LifeSpanSchema> | undefined,
): string | undefined {
  if (!span) return;
  const endedNote = typeof span.ended === 'boolean' ? ` (ended: ${span.ended ? 'yes' : 'no'})` : '';
  if (span.begin && span.end) return `**Life span:** ${span.begin} – ${span.end}${endedNote}`;
  if (span.begin)
    return `**Life span:** ${span.begin} – ${span.ended ? 'ended' : 'present'}${endedNote}`;
  if (span.end) return `**Life span:** ended ${span.end}${endedNote}`;
  if (typeof span.ended === 'boolean') return `**Life span:** ended: ${span.ended ? 'yes' : 'no'}`;
  return;
}

/** Render the cover-art availability stub completely (exists/count/front/back). */
export function renderCoverArtStub(stub: z.infer<typeof CoverArtStubSchema>): string {
  const parts = [
    `exists: ${stub.exists ? 'yes' : 'no'}`,
    typeof stub.count === 'number' ? `count: ${stub.count}` : null,
    typeof stub.front === 'boolean' ? `front: ${stub.front ? 'yes' : 'no'}` : null,
    typeof stub.back === 'boolean' ? `back: ${stub.back ? 'yes' : 'no'}` : null,
  ].filter(Boolean);
  return `**Cover art:** ${parts.join(', ')}`;
}

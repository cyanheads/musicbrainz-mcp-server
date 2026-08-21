/**
 * @fileoverview musicbrainz_get_artist — artist profile by MBID: type, country,
 * life span, gender, area, aliases, tags/genres, plus discography (release-groups)
 * and band-membership / collaboration relationships and external links. The 80%
 * artist-detail call. Discography and relationships are capped at one page by the
 * lookup endpoint — musicbrainz_browse_entities enumerates the full set.
 * @module mcp-server/tools/definitions/get-artist.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import type { RawArtist } from '@/services/musicbrainz/types.js';
import {
  AliasSchema,
  classifyMbidError,
  ExternalLinkSchema,
  LifeSpanSchema,
  MBID_EXAMPLE,
  normalizeAliases,
  normalizeLifeSpan,
  normalizeRelations,
  normalizeTags,
  RelationSchema,
  renderAliases,
  renderExternalLinks,
  renderLifeSpan,
  renderRelationships,
  renderTags,
  safeText,
  TagSchema,
} from './_shared.js';

/** One page cap for lookup `inc` embedded lists (25 default / 100 max, no deep offset). */
const LOOKUP_PAGE_CAP = 25;

const ReleaseGroupRefSchema = z
  .object({
    mbid: z.string().describe('Release-group MBID — chain to musicbrainz_get_release_group.'),
    title: z.string().describe('Release-group title.'),
    primaryType: z
      .string()
      .optional()
      .describe('Primary type (Album, Single, EP, …). Omitted when absent.'),
    secondaryTypes: z
      .array(z.string())
      .optional()
      .describe('Secondary types (Live, Compilation, …). Omitted when none.'),
    firstReleaseDate: z.string().optional().describe('First-release date. Omitted when absent.'),
    disambiguation: z.string().optional().describe('Short qualifier. Omitted when absent.'),
  })
  .describe('A release-group in the artist discography (capped to one page — use browse for all).');

export const getArtistTool = tool('musicbrainz_get_artist', {
  title: 'musicbrainz-mcp-server: get artist',
  description:
    "Artist profile by MBID: type (person/group/…), country, life span, gender, area, aliases, tags/genres, plus the discography (release-groups) and band-membership / collaboration relationships and external links (Wikidata QID, Discogs, official site — surfaced as url-rels chainable to those servers). The 80% artist-detail call. Discography and relationships are capped at one page (25); for a prolific artist's complete release-group list, call musicbrainz_browse_entities with target_type=release-group and the artist link.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_mbid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The MBID is malformed or the all-zeros sentinel (MusicBrainz returns HTTP 400).',
      recovery: `MBID must be a 36-character UUID (e.g. ${MBID_EXAMPLE}). Use musicbrainz_search_entities to find an artist's MBID from its name.`,
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The MBID is well-formed but no artist exists with it (MusicBrainz returns HTTP 404).',
      recovery:
        'No artist exists with that MBID. Verify the ID, or search by name with musicbrainz_search_entities.',
    },
  ],

  input: z.object({
    mbid: z.string().describe('Artist MBID (36-character UUID).'),
    inc_release_groups: z
      .boolean()
      .default(true)
      .describe(
        'Include the discography (release-groups). Capped at one page; use browse for the full set.',
      ),
    inc_relationships: z
      .boolean()
      .default(true)
      .describe(
        'Include band-membership / collaboration relationships and external links (url-rels).',
      ),
  }),

  output: z.object({
    mbid: z.string().describe('Artist MBID.'),
    name: z.string().describe('Artist name.'),
    sortName: z.string().optional().describe('Sortable name form. Omitted when absent.'),
    disambiguation: z
      .string()
      .optional()
      .describe('Short qualifier distinguishing same-named artists. Omitted when absent.'),
    type: z
      .string()
      .optional()
      .describe('Artist type (Person, Group, Orchestra, …). Omitted when unknown.'),
    gender: z
      .string()
      .optional()
      .describe('Gender, for person-type artists. Omitted when unknown/inapplicable.'),
    country: z.string().optional().describe('ISO country code. Omitted when unknown.'),
    area: z.string().optional().describe('Associated area name. Omitted when unknown.'),
    lifeSpan: LifeSpanSchema.optional().describe(
      'Birth/death or formation/dissolution span. Omitted when unknown.',
    ),
    aliases: z.array(AliasSchema).describe('Alternate names (may be empty).'),
    tags: z.array(TagSchema).describe('Community tags/genres with vote counts (may be empty).'),
    releaseGroups: z
      .array(ReleaseGroupRefSchema)
      .describe('Discography — release-groups (one page; may be empty or capped).'),
    relationships: z
      .array(RelationSchema)
      .describe('Band membership and collaboration relationships (may be empty).'),
    externalLinks: z
      .array(ExternalLinkSchema)
      .describe(
        'External resource links (url-rels) — Wikidata, Discogs, official site (may be empty).',
      ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the discography hit the one-page cap and more release-groups exist. Absent when the full set fit in one page.',
      ),
    shown: z
      .number()
      .optional()
      .describe('Number of release-groups returned. Absent when not truncated.'),
    cap: z
      .number()
      .optional()
      .describe('The one-page cap that was applied. Absent when not truncated.'),
    notice: z.string().optional().describe('How to fetch the complete discography when truncated.'),
  },

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_get_artist', { mbid: input.mbid });
    const service = getMusicBrainzService();

    const inc: string[] = ['aliases', 'tags', 'genres'];
    if (input.inc_release_groups) inc.push('release-groups');
    if (input.inc_relationships) inc.push('artist-rels', 'url-rels');

    let raw: RawArtist;
    try {
      raw = await service.lookup<RawArtist>('artist', input.mbid, { inc }, ctx, {
        signal: ctx.signal,
      });
    } catch (error: unknown) {
      const reason = classifyMbidError(error);
      if (reason)
        throw ctx.fail(reason, undefined, { ...ctx.recoveryFor(reason), mbid: input.mbid });
      throw error;
    }

    const { relationships, externalLinks } = normalizeRelations(raw.relations);
    const releaseGroups = (raw['release-groups'] ?? []).map((rg) => ({
      mbid: rg.id,
      title: rg.title ?? '',
      ...(rg['primary-type'] ? { primaryType: rg['primary-type'] } : {}),
      ...(rg['secondary-types']?.length ? { secondaryTypes: rg['secondary-types'] } : {}),
      ...(rg['first-release-date'] ? { firstReleaseDate: rg['first-release-date'] } : {}),
      ...(rg.disambiguation ? { disambiguation: rg.disambiguation } : {}),
    }));

    const lifeSpan = normalizeLifeSpan(raw['life-span']);

    if (input.inc_release_groups && releaseGroups.length >= LOOKUP_PAGE_CAP) {
      ctx.enrich.truncated({ shown: releaseGroups.length, cap: LOOKUP_PAGE_CAP });
      ctx.enrich.notice(
        `Discography capped at ${LOOKUP_PAGE_CAP}. Call musicbrainz_browse_entities (target_type=release-group, link.artist=${input.mbid}) to enumerate the complete set.`,
      );
    }

    return {
      mbid: raw.id,
      name: raw.name ?? '',
      ...(raw['sort-name'] ? { sortName: raw['sort-name'] } : {}),
      ...(raw.disambiguation ? { disambiguation: raw.disambiguation } : {}),
      ...(raw.type ? { type: raw.type } : {}),
      ...(raw.gender ? { gender: raw.gender } : {}),
      ...(raw.country ? { country: raw.country } : {}),
      ...(raw.area?.name ? { area: raw.area.name } : {}),
      ...(lifeSpan ? { lifeSpan } : {}),
      aliases: normalizeAliases(raw.aliases),
      tags: normalizeTags(raw.tags ?? raw.genres),
      releaseGroups,
      relationships,
      externalLinks,
    };
  },

  format: (result) => {
    const lines = [
      `## ${safeText(result.name)}${result.disambiguation ? ` (${safeText(result.disambiguation)})` : ''}`,
    ];
    lines.push(`**MBID:** ${result.mbid}`);
    if (result.type) lines.push(`**Type:** ${safeText(result.type)}`);
    if (result.gender) lines.push(`**Gender:** ${safeText(result.gender)}`);
    if (result.country) lines.push(`**Country:** ${result.country}`);
    if (result.area) lines.push(`**Area:** ${safeText(result.area)}`);
    const ls = renderLifeSpan(result.lifeSpan);
    if (ls) lines.push(ls);
    if (result.sortName) lines.push(`**Sort name:** ${safeText(result.sortName)}`);
    const tags = renderTags(result.tags);
    if (tags) lines.push(tags);
    const aliases = renderAliases(result.aliases);
    if (aliases) lines.push(aliases);

    if (result.releaseGroups.length) {
      lines.push('', '### Discography');
      for (const rg of result.releaseGroups) {
        const meta = [
          rg.primaryType ? safeText(rg.primaryType) : null,
          ...(rg.secondaryTypes?.map(safeText) ?? []),
          rg.firstReleaseDate,
        ]
          .filter(Boolean)
          .join(', ');
        const dis = rg.disambiguation ? ` [${safeText(rg.disambiguation)}]` : '';
        lines.push(`- **${safeText(rg.title)}**${dis}${meta ? ` (${meta})` : ''} — ${rg.mbid}`);
      }
    }
    lines.push(...renderRelationships(result.relationships));
    lines.push(...renderExternalLinks(result.externalLinks));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

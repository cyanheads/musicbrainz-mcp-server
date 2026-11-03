/**
 * @fileoverview musicbrainz_get_label — label by MBID: type, country, life span,
 * label code, area, aliases, tags, and external links. Its releases are a
 * potentially huge linked set — fetch them via musicbrainz_browse_entities
 * (release by label), not here.
 * @module mcp-server/tools/definitions/get-label.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import type { RawLabel } from '@/services/musicbrainz/types.js';
import {
  AliasSchema,
  classifyMbidError,
  ExternalLinkSchema,
  LifeSpanSchema,
  MBID_EXAMPLE,
  MbidInput,
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

export const getLabelTool = tool('musicbrainz_get_label', {
  title: 'musicbrainz-mcp-server: get label',
  description:
    "Label by MBID: type (Original Production, Reissue, Imprint, …), country, life span, label code (the LC number), area and areaId, IPI/ISNI identifiers, aliases, tags, ownership/imprint/distribution relationships, and external links (url-rels — Wikidata, Discogs, official site). Chain areaId into musicbrainz_browse_entities link.area. A label's releases are a potentially huge linked set (a major label can have tens of thousands), so they are NOT embedded here — enumerate them with musicbrainz_browse_entities (target_type=release, link.label).",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_mbid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The MBID is malformed or the all-zeros sentinel (rejected before fetch), or MusicBrainz rejects it with HTTP 400.',
      recovery: `MBID must be a 36-character UUID (e.g. ${MBID_EXAMPLE}). Use musicbrainz_search_entities (entityType=label) to find one from a name.`,
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The MBID is well-formed but no label exists with it (MusicBrainz returns HTTP 404).',
      recovery:
        'No label exists with that MBID. Verify the ID, or search by name with musicbrainz_search_entities.',
    },
  ],

  input: z.object({
    mbid: MbidInput.describe(
      'Label MBID (hyphenated hexadecimal UUID; surrounding whitespace and uppercase accepted).',
    ),
  }),

  output: z.object({
    mbid: z.string().describe('Label MBID.'),
    name: z.string().describe('Label name.'),
    sortName: z.string().optional().describe('Sortable name form. Omitted when absent.'),
    disambiguation: z.string().optional().describe('Short qualifier. Omitted when absent.'),
    type: z.string().optional().describe('Label type. Omitted when unknown.'),
    labelCode: z
      .number()
      .optional()
      .describe('Label code (LC number), without the "LC" prefix. Omitted when absent.'),
    country: z.string().optional().describe('ISO country code. Omitted when unknown.'),
    area: z.string().optional().describe('Associated area name. Omitted when unknown.'),
    areaId: z
      .string()
      .optional()
      .describe('Area MBID for musicbrainz_browse_entities link.area. Omitted when unknown.'),
    ipis: z
      .array(z.string())
      .describe('IPI identifiers as exact strings in upstream order (may be empty).'),
    isnis: z
      .array(z.string())
      .describe('ISNI identifiers as exact strings in upstream order (may be empty).'),
    lifeSpan: LifeSpanSchema.optional().describe(
      'Founding/dissolution span. Omitted when unknown.',
    ),
    aliases: z.array(AliasSchema).describe('Alternate names (may be empty).'),
    tags: z.array(TagSchema).describe('Community tags/genres (may be empty).'),
    externalLinks: z
      .array(ExternalLinkSchema)
      .describe('External resource links (url-rels) (may be empty).'),
    relationships: z
      .array(RelationSchema)
      .describe(
        'Label ownership, imprint and distribution relationships in upstream order, uncapped (may be empty).',
      ),
  }),

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_get_label', { mbid: input.mbid });
    const service = getMusicBrainzService();

    let raw: RawLabel;
    try {
      raw = await service.lookup<RawLabel>(
        'label',
        input.mbid,
        { inc: ['aliases', 'tags', 'genres', 'url-rels', 'label-rels'] },
        ctx,
        { signal: ctx.signal },
      );
    } catch (error: unknown) {
      const reason = classifyMbidError(error);
      if (reason === 'invalid_mbid')
        throw ctx.fail('invalid_mbid', undefined, { mbid: input.mbid });
      if (reason === 'entity_not_found')
        throw ctx.fail('entity_not_found', undefined, { mbid: input.mbid });
      throw error;
    }

    const { relationships, externalLinks } = normalizeRelations(raw.relations);
    const lifeSpan = normalizeLifeSpan(raw['life-span']);

    return {
      mbid: raw.id,
      name: raw.name ?? '',
      ...(raw['sort-name'] ? { sortName: raw['sort-name'] } : {}),
      ...(raw.disambiguation ? { disambiguation: raw.disambiguation } : {}),
      ...(raw.type ? { type: raw.type } : {}),
      ...(typeof raw['label-code'] === 'number' ? { labelCode: raw['label-code'] } : {}),
      ...(raw.country ? { country: raw.country } : {}),
      ...(raw.area?.name ? { area: raw.area.name } : {}),
      ...(raw.area?.id ? { areaId: raw.area.id } : {}),
      ipis: raw.ipis ?? [],
      isnis: raw.isnis ?? [],
      ...(lifeSpan ? { lifeSpan } : {}),
      aliases: normalizeAliases(raw.aliases),
      tags: normalizeTags(raw.tags ?? raw.genres),
      externalLinks,
      relationships,
    };
  },

  format: (result) => {
    const lines = [
      `## ${safeText(result.name)}${result.disambiguation ? ` (${safeText(result.disambiguation)})` : ''}`,
    ];
    lines.push(`**MBID:** ${result.mbid}`);
    if (result.type) lines.push(`**Type:** ${safeText(result.type)}`);
    if (typeof result.labelCode === 'number') lines.push(`**Label code:** LC ${result.labelCode}`);
    if (result.country) lines.push(`**Country:** ${result.country}`);
    if (result.area) lines.push(`**Area:** ${safeText(result.area)}`);
    if (result.areaId) lines.push(`**Area MBID:** ${result.areaId}`);
    if (result.ipis.length) lines.push(`**IPIs:** ${result.ipis.map(safeText).join(', ')}`);
    if (result.isnis.length) lines.push(`**ISNIs:** ${result.isnis.map(safeText).join(', ')}`);
    const ls = renderLifeSpan(result.lifeSpan);
    if (ls) lines.push(ls);
    if (result.sortName) lines.push(`**Sort name:** ${safeText(result.sortName)}`);
    const tags = renderTags(result.tags);
    if (tags) lines.push(tags);
    const aliases = renderAliases(result.aliases);
    if (aliases) lines.push(aliases);
    lines.push(...renderExternalLinks(result.externalLinks));
    lines.push(...renderRelationships(result.relationships));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

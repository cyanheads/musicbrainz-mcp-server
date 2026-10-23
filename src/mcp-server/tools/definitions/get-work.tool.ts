/**
 * @fileoverview musicbrainz_get_work — work (a composition, the song as written,
 * distinct from any recording) by MBID: type, language(s), ISWCs, writer/composer/
 * lyricist relationships, movements, arrangements, and the recordings that perform it. The work lookup
 * returns the first 25 recording relationships and every non-recording relation.
 * @module mcp-server/tools/definitions/get-work.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import type { RawWork } from '@/services/musicbrainz/types.js';
import { sliceWorkRelations } from '@/services/musicbrainz/work-relations.js';
import {
  AliasSchema,
  classifyMbidError,
  ExternalLinkSchema,
  MBID_EXAMPLE,
  MbidInput,
  normalizeAliases,
  normalizeRelations,
  normalizeTags,
  RelationSchema,
  renderAliases,
  renderExternalLinks,
  renderRelationships,
  renderTags,
  safeText,
  TagSchema,
} from './_shared.js';

export const getWorkTool = tool('musicbrainz_get_work', {
  title: 'musicbrainz-mcp-server: get work',
  description:
    'Work (a composition, distinct from a recording) by MBID: type, languages, ISWCs, writers/composers/lyricists, movements, arrangements, aliases, tags, and external links. Follow work target MBIDs with this tool; direction, orderingKey, and targetDisambiguation distinguish parts and arrangements without reordering relationships. This server returns the first 25 recording relationships with their exact total and actual truncation disclosure, preserving all other relationships. Browse recording entities with musicbrainz_browse_entities (target_type=recording, link.work), then use musicbrainz_get_recording for work relationship attributes and dates; browse alone does not return those details.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_mbid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The MBID is malformed or the all-zeros sentinel (rejected before fetch), or MusicBrainz rejects it with HTTP 400.',
      recovery: `MBID must be a 36-character UUID (e.g. ${MBID_EXAMPLE}). Use musicbrainz_search_entities (entityType=work) to find one from a title.`,
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The MBID is well-formed but no work exists with it (MusicBrainz returns HTTP 404).',
      recovery:
        'No work exists with that MBID. Verify the ID, or search by title with musicbrainz_search_entities.',
    },
  ],

  input: z.object({
    mbid: MbidInput.describe(
      'Work MBID (hyphenated hexadecimal UUID; surrounding whitespace and uppercase accepted).',
    ),
    inc_relationships: z
      .boolean()
      .default(true)
      .describe(
        'Include writer/composer, movement/arrangement and recording relationships, and external links.',
      ),
  }),

  output: z.object({
    mbid: z.string().describe('Work MBID.'),
    title: z.string().describe('Work title.'),
    disambiguation: z.string().optional().describe('Short qualifier. Omitted when absent.'),
    type: z.string().optional().describe('Work type (Song, Symphony, …). Omitted when unknown.'),
    languages: z.array(z.string()).describe('Lyrics languages (ISO codes; may be empty).'),
    iswcs: z.array(z.string()).describe('ISWCs assigned to this work (may be empty).'),
    aliases: z.array(AliasSchema).describe('Alternate titles (may be empty).'),
    tags: z.array(TagSchema).describe('Community tags/genres (may be empty).'),
    relationships: z
      .array(RelationSchema)
      .describe(
        'All non-recording relationships and the first 25 recording relationships in upstream order (may be empty).',
      ),
    externalLinks: z
      .array(ExternalLinkSchema)
      .describe('External resource links (url-rels) (may be empty).'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        'Exact number of recording relationships before the server-side slice. Absent when relationships are disabled.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True only when recording relationships were omitted beyond 25.'),
    shown: z
      .number()
      .optional()
      .describe('Number of recording relationships returned when truncated.'),
    cap: z.number().optional().describe('Server-side recording relationship cap, when truncated.'),
    notice: z
      .string()
      .optional()
      .describe('Recording enumeration and relationship-detail retrieval guidance when truncated.'),
  },

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_get_work', { mbid: input.mbid });
    const service = getMusicBrainzService();

    const inc = ['aliases', 'tags', 'genres'];
    if (input.inc_relationships) inc.push('artist-rels', 'work-rels', 'recording-rels', 'url-rels');

    let raw: RawWork;
    try {
      raw = await service.lookup<RawWork>('work', input.mbid, { inc }, ctx, { signal: ctx.signal });
    } catch (error: unknown) {
      const reason = classifyMbidError(error);
      if (reason === 'invalid_mbid')
        throw ctx.fail('invalid_mbid', undefined, { mbid: input.mbid });
      if (reason === 'entity_not_found')
        throw ctx.fail('entity_not_found', undefined, { mbid: input.mbid });
      throw error;
    }

    const slice = sliceWorkRelations(input.inc_relationships ? raw.relations : undefined, raw.id);
    const { relationships, externalLinks } = normalizeRelations(slice.relations);
    if (input.inc_relationships) ctx.enrich(slice.summary);
    const languages = raw.languages ?? (raw.language ? [raw.language] : []);

    return {
      mbid: raw.id,
      title: raw.title ?? '',
      ...(raw.disambiguation ? { disambiguation: raw.disambiguation } : {}),
      ...(raw.type ? { type: raw.type } : {}),
      languages,
      iswcs: raw.iswcs ?? [],
      aliases: normalizeAliases(raw.aliases),
      tags: normalizeTags(raw.tags ?? raw.genres),
      relationships,
      externalLinks,
    };
  },

  format: (result) => {
    const lines = [
      `## ${safeText(result.title)}${result.disambiguation ? ` (${safeText(result.disambiguation)})` : ''}`,
    ];
    lines.push(`**MBID:** ${result.mbid}`);
    if (result.type) lines.push(`**Type:** ${safeText(result.type)}`);
    if (result.languages.length) lines.push(`**Languages:** ${result.languages.join(', ')}`);
    if (result.iswcs.length) lines.push(`**ISWCs:** ${result.iswcs.join(', ')}`);
    const tags = renderTags(result.tags);
    if (tags) lines.push(tags);
    const aliases = renderAliases(result.aliases);
    if (aliases) lines.push(aliases);
    lines.push(...renderRelationships(result.relationships));
    lines.push(...renderExternalLinks(result.externalLinks));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

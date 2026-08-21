/**
 * @fileoverview musicbrainz_get_work — work (a composition, the song as written,
 * distinct from any recording) by MBID: type, language(s), ISWCs, writer/composer/
 * lyricist relationships, and the recordings that perform it. The work lookup
 * returns every recording relationship unbounded (no per-page cap).
 * @module mcp-server/tools/definitions/get-work.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import type { RawWork } from '@/services/musicbrainz/types.js';
import {
  AliasSchema,
  classifyMbidError,
  ExternalLinkSchema,
  MBID_EXAMPLE,
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
    'Work (a composition — the song as written, distinct from any specific recording) by MBID: type, language(s), ISWCs (the work-level standard identifier), writer/composer/lyricist relationships (with the credited artist MBID), aliases, tags, and the recordings that perform it. The recording relationships are returned in full (the work lookup does not page them).',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_mbid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The MBID is malformed or the all-zeros sentinel (MusicBrainz returns HTTP 400).',
      recovery: `MBID must be a 36-character UUID (e.g. ${MBID_EXAMPLE}). Use musicbrainz_search_entities (entity_type=work) to find one from a title.`,
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
    mbid: z.string().describe('Work MBID (36-character UUID).'),
    inc_relationships: z
      .boolean()
      .default(true)
      .describe(
        'Include writer/composer relationships, recording relationships, and external links.',
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
        'Writer/composer/lyricist relationships and recording-rels — the complete set (may be empty).',
      ),
    externalLinks: z
      .array(ExternalLinkSchema)
      .describe('External resource links (url-rels) (may be empty).'),
  }),

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_get_work', { mbid: input.mbid });
    const service = getMusicBrainzService();

    const inc = ['aliases', 'tags', 'genres'];
    if (input.inc_relationships) inc.push('artist-rels', 'recording-rels', 'url-rels');

    let raw: RawWork;
    try {
      raw = await service.lookup<RawWork>('work', input.mbid, { inc }, ctx, { signal: ctx.signal });
    } catch (error: unknown) {
      const reason = classifyMbidError(error);
      if (reason)
        throw ctx.fail(reason, undefined, { ...ctx.recoveryFor(reason), mbid: input.mbid });
      throw error;
    }

    const { relationships, externalLinks } = normalizeRelations(raw.relations);
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

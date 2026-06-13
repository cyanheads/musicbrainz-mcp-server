/**
 * @fileoverview musicbrainz_get_cover_art — Cover Art Archive images for a release
 * or release-group MBID: front/back flags, image types, full-resolution URLs, and
 * 250/500/1200px thumbnails. Returns an empty image set (not an error) when the
 * entity has no art. Separate from musicbrainz_get_release so art is fetchable
 * without the full record.
 * @module mcp-server/tools/definitions/get-cover-art.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCoverArtService } from '@/services/cover-art/cover-art-service.js';
import type { RawCoverArtResponse } from '@/services/musicbrainz/types.js';
import { MBID_EXAMPLE, safeText } from './_shared.js';

const ImageSchema = z
  .object({
    id: z.string().describe('Cover Art Archive image ID.'),
    front: z.boolean().describe('Whether this is a designated front image.'),
    back: z.boolean().describe('Whether this is a designated back image.'),
    types: z
      .array(z.string())
      .describe('Image types (Front, Back, Booklet, Medium, …; may be empty).'),
    imageUrl: z
      .string()
      .describe(
        'Full-resolution image URL (linked, not rehosted — copyright stays with the rights holder).',
      ),
    thumbnail250: z.string().optional().describe('250px thumbnail URL. Omitted when unavailable.'),
    thumbnail500: z.string().optional().describe('500px thumbnail URL. Omitted when unavailable.'),
    thumbnail1200: z
      .string()
      .optional()
      .describe('1200px thumbnail URL. Omitted when unavailable.'),
    approved: z
      .boolean()
      .optional()
      .describe('Whether the image is community-approved. Omitted when unknown.'),
    comment: z.string().optional().describe('Editor comment on the image. Omitted when absent.'),
  })
  .describe('One cover-art image with its full URL and thumbnails.');

export const getCoverArtTool = tool('musicbrainz_get_cover_art', {
  title: 'musicbrainz-mcp-server: get cover art',
  description:
    "Cover Art Archive images for a release or release-group MBID: front/back flags, image types, full-resolution URLs, and 250/500/1200px thumbnail URLs. Returns an empty image set (NOT an error) when the entity has no art — absence of art is information. Art is served at the release level; a release-group MBID resolves to a representative release's art automatically. URLs are linked, never rehosted — image copyright stays with the rights holders (only MusicBrainz core metadata is CC0).",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_mbid',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The MBID is malformed or the all-zeros sentinel (the upstream returns HTTP 400).',
      recovery: `MBID must be a 36-character UUID (e.g. ${MBID_EXAMPLE}). Use musicbrainz_search_entities to find a release or release-group MBID.`,
    },
  ],

  input: z.object({
    mbid: z.string().describe('Release or release-group MBID (36-character UUID).'),
    entity_type: z
      .enum(['release', 'release-group'])
      .default('release')
      .describe('Whether the MBID is a release (default) or a release-group.'),
  }),

  output: z.object({
    mbid: z.string().describe('The MBID that was queried.'),
    entityType: z.string().describe('Whether the MBID was treated as a release or release-group.'),
    representativeRelease: z
      .string()
      .optional()
      .describe(
        'For a release-group query, the release MBID whose art was returned. Omitted for direct release queries.',
      ),
    images: z.array(ImageSchema).describe('Cover-art images (empty when the entity has no art).'),
  }),

  enrichment: {
    hasArt: z.boolean().describe('Whether any cover art exists for this entity.'),
    notice: z.string().optional().describe('Notice when no art exists for the entity.'),
  },

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_get_cover_art', { mbid: input.mbid, entityType: input.entity_type });
    const service = getCoverArtService();

    let raw: RawCoverArtResponse;
    try {
      raw = await service.getImages(input.entity_type, input.mbid, ctx, { signal: ctx.signal });
    } catch (error: unknown) {
      // 404 (no art) is mapped to an empty set inside the service; a 400 (malformed
      // MBID) still surfaces here as InvalidParams.
      if (error instanceof McpError && error.code === JsonRpcErrorCode.InvalidParams) {
        throw ctx.fail('invalid_mbid', undefined, {
          ...ctx.recoveryFor('invalid_mbid'),
          mbid: input.mbid,
        });
      }
      throw error;
    }

    const images = (raw.images ?? []).map((img) => ({
      id: String(img.id ?? ''),
      front: img.front === true,
      back: img.back === true,
      types: img.types ?? [],
      imageUrl: img.image ?? '',
      ...(img.thumbnails?.['250'] ? { thumbnail250: img.thumbnails['250'] } : {}),
      ...(img.thumbnails?.['500'] ? { thumbnail500: img.thumbnails['500'] } : {}),
      ...(img.thumbnails?.['1200'] ? { thumbnail1200: img.thumbnails['1200'] } : {}),
      ...(typeof img.approved === 'boolean' ? { approved: img.approved } : {}),
      ...(img.comment ? { comment: img.comment } : {}),
    }));

    ctx.enrich({ hasArt: images.length > 0 });
    if (images.length === 0) {
      ctx.enrich.notice(
        `No cover art exists for ${input.entity_type} ${input.mbid}. This is not an error — the Cover Art Archive simply has no images for it.`,
      );
    }

    // The representative release MBID is the trailing path segment of the `release`
    // URL the CAA returns (present on release-group lookups after the 307 redirect).
    const representativeRelease = raw.release?.split('/').filter(Boolean).pop();

    return {
      mbid: input.mbid,
      entityType: input.entity_type,
      ...(input.entity_type === 'release-group' && representativeRelease
        ? { representativeRelease }
        : {}),
      images,
    };
  },

  format: (result) => {
    const lines = [`## Cover art: ${result.entityType} ${result.mbid}`];
    if (result.representativeRelease)
      lines.push(`**Representative release:** ${result.representativeRelease}`);
    if (result.images.length === 0) {
      lines.push('', '_No cover art available for this entity._');
    } else {
      lines.push(`**Images:** ${result.images.length}`);
      for (const img of result.images) {
        const flags = [
          img.front ? 'front' : null,
          img.back ? 'back' : null,
          ...img.types.map(safeText),
        ]
          .filter(Boolean)
          .join(', ');
        lines.push(`\n### Image ${safeText(img.id)}${flags ? ` (${flags})` : ''}`);
        lines.push(`**Full:** ${safeText(img.imageUrl)}`);
        if (img.thumbnail250) lines.push(`**250px:** ${safeText(img.thumbnail250)}`);
        if (img.thumbnail500) lines.push(`**500px:** ${safeText(img.thumbnail500)}`);
        if (img.thumbnail1200) lines.push(`**1200px:** ${safeText(img.thumbnail1200)}`);
        if (typeof img.approved === 'boolean')
          lines.push(`**Approved:** ${img.approved ? 'yes' : 'no'}`);
        if (img.comment) lines.push(`**Comment:** ${safeText(img.comment)}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

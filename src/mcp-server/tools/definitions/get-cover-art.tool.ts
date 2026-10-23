/**
 * @fileoverview musicbrainz_get_cover_art — Cover Art Archive images for a release
 * or release-group MBID: front/back flags, image types, full-resolution URLs, and
 * 250/500/1200px thumbnails. Returns an empty image set (not an error) when the
 * entity has no art. Malformed/all-zero MBIDs fail before fetch. For a well-shaped
 * MBID an archive 404 means no art or no entity, so the handler checks it with a
 * bounded MusicBrainz lookup of the same entity type before reporting "no art".
 * Separate from musicbrainz_get_release so art is
 * fetchable without the full record.
 * @module mcp-server/tools/definitions/get-cover-art.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { type CoverArtLookup, getCoverArtService } from '@/services/cover-art/cover-art-service.js';
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import { classifyMbidError, MBID_EXAMPLE, MbidInput, safeText, safeUrl } from './_shared.js';

/**
 * Bounds on the MBID check made after a Cover Art Archive 404: one attempt, a
 * short timeout. It only decides between "no art" and an MBID error, so a slow
 * or failing MusicBrainz degrades the answer to "existence unconfirmed" instead
 * of stalling or failing the call.
 */
const VERIFY_LOOKUP_BOUNDS = { timeoutMs: 5_000, maxRetries: 0 } as const;

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
    "Cover Art Archive images for a release or release-group MBID: front/back flags, image types, full-resolution URLs, and 250/500/1200px thumbnail URLs. limit defaults to 25 and clamps above 100; offset defaults to 0. Pages retain archive order, totalCount counts all images, and hasArt describes the full archive even on an empty page. Follow the notice for the next offset. No art is a successful empty result; an unknown MBID fails with entity_not_found after a bounded MusicBrainz check. A release-group resolves to a representative release's art. URLs are linked, never rehosted; image copyright stays with rights holders.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_mbid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The MBID is malformed or the all-zeros sentinel (rejected before fetch), or an upstream rejects it with HTTP 400.',
      recovery: `MBID must be a 36-character UUID (e.g. ${MBID_EXAMPLE}). Use musicbrainz_search_entities to find a release or release-group MBID.`,
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The MBID is well-formed but no entity of the given entity_type exists with it (the archive returns 404 and the MusicBrainz check of the MBID returns 404).',
      recovery:
        'No release or release-group exists with that MBID. Check that entity_type matches the MBID (a release-group MBID needs entity_type=release-group), or find the MBID with musicbrainz_search_entities.',
    },
  ],

  input: z.object({
    mbid: MbidInput.describe(
      'Release or release-group MBID (hyphenated hexadecimal UUID; surrounding whitespace and uppercase accepted).',
    ),
    entity_type: z
      .enum(['release', 'release-group'])
      .default('release')
      .describe('Whether the MBID is a release (default) or a release-group.'),
    limit: z
      .number()
      .int()
      .min(1)
      .default(25)
      .describe(
        'Maximum images returned (default 25; values above 100 clamp to 100 with a notice).',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based image offset in archive order (default 0).'),
  }),

  output: z.object({
    mbid: z.string().describe('The MBID that was queried.'),
    entityType: z.string().describe('Whether the MBID was treated as a release or release-group.'),
    offset: z.number().describe('Effective zero-based image offset in archive order.'),
    representativeRelease: z
      .string()
      .optional()
      .describe(
        'For a release-group query, the release MBID whose art was returned. Omitted for direct release queries.',
      ),
    images: z
      .array(ImageSchema)
      .describe(
        'Selected cover-art images in archive order (empty for no art or an exhausted page).',
      ),
  }),

  enrichment: {
    hasArt: z.boolean().describe('Whether any cover art exists for this entity.'),
    totalCount: z.number().describe('Exact image total before the limit and offset window.'),
    truncated: z.boolean().optional().describe('True when images remain after this nonempty page.'),
    shown: z.number().optional().describe('Images returned when more remain.'),
    cap: z.number().optional().describe('Applied image limit when more remain.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Combined limit clamp, continuation, exhausted page, or no-art/existence-unconfirmed guidance.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_get_cover_art', { mbid: input.mbid, entityType: input.entity_type });

    let raw: CoverArtLookup;
    try {
      raw = await getCoverArtService().getImages(input.entity_type, input.mbid, ctx, {
        signal: ctx.signal,
      });
    } catch (error: unknown) {
      /**
       * The service maps 404 to `found: false`; local MBID rejection and
       * upstream 400 both surface as ValidationError.
       */
      if (error instanceof McpError && error.code === JsonRpcErrorCode.ValidationError) {
        throw ctx.fail('invalid_mbid', undefined, { mbid: input.mbid });
      }
      throw error;
    }

    /**
     * A CAA 404 cannot tell "no art" from "no such entity" — MusicBrainz
     * answers 404 for an unknown MBID and 200 for an existing entity.
     */
    let existenceConfirmed = true;
    if (!raw.found) {
      try {
        await getMusicBrainzService().lookup(input.entity_type, input.mbid, { inc: [] }, ctx, {
          signal: ctx.signal,
          ...VERIFY_LOOKUP_BOUNDS,
        });
      } catch (error: unknown) {
        ctx.signal.throwIfAborted();
        const reason = classifyMbidError(error);
        if (reason === 'invalid_mbid')
          throw ctx.fail('invalid_mbid', undefined, { mbid: input.mbid });
        if (reason === 'entity_not_found')
          throw ctx.fail(
            'entity_not_found',
            `No ${input.entity_type} exists with MBID ${input.mbid}.`,
            { mbid: input.mbid },
          );
        // Best-effort: an upstream fault (5xx, timeout, rate limit) leaves the
        // no-art answer standing, flagged unconfirmed. Anything else is a bug.
        if (!(error instanceof McpError)) throw error;
        ctx.log.warning('MBID check after Cover Art Archive 404 failed; existence unconfirmed', {
          mbid: input.mbid,
          entityType: input.entity_type,
          code: error.code,
        });
        existenceConfirmed = false;
      }
    }

    const totalCount = raw.images?.length ?? 0;
    const limit = Math.min(input.limit, 100);
    const images = (raw.images ?? []).slice(input.offset, input.offset + limit).map((img) => ({
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

    ctx.enrich({ hasArt: totalCount > 0 });
    ctx.enrich.total(totalCount);
    const notices: string[] = [];
    if (input.limit > limit)
      notices.push(`Requested limit=${input.limit}; applied limit=${limit} (maximum 100).`);
    const nextOffset = input.offset + images.length;
    if (images.length > 0 && nextOffset < totalCount) {
      ctx.enrich({ truncated: true, shown: images.length, cap: limit });
      notices.push(
        `Showing ${images.length} of ${totalCount} images at offset=${input.offset}. Continue with musicbrainz_get_cover_art (mbid=${input.mbid}, entity_type=${input.entity_type}, limit=${limit}, offset=${nextOffset}).`,
      );
    } else if (totalCount > 0 && images.length === 0) {
      notices.push(
        `Image page exhausted at offset=${input.offset}; ${totalCount} images exist for this entity.`,
      );
    } else if (totalCount === 0) {
      notices.push(
        existenceConfirmed
          ? `No cover art exists for ${input.entity_type} ${input.mbid}. This is not an error — the Cover Art Archive simply has no images for it.`
          : `The Cover Art Archive has no images for ${input.entity_type} ${input.mbid}, but whether that MBID exists in MusicBrainz could not be confirmed (the check failed upstream). If the MBID may be wrong, verify it with musicbrainz_search_entities.`,
      );
    }
    if (notices.length) ctx.enrich.notice(notices.join(' '));

    // The representative release MBID is the trailing path segment of the `release`
    // URL the CAA returns (present on release-group lookups after the 307 redirect).
    const representativeRelease = raw.release?.split('/').filter(Boolean).pop();

    return {
      mbid: input.mbid.trim().toLowerCase(),
      entityType: input.entity_type,
      offset: input.offset,
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
    lines.push(`**Image window:** offset: ${result.offset}, shown: ${result.images.length}`);
    if (result.images.length === 0) {
      lines.push('', '_No cover art available in this image page; the page is empty._');
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
        lines.push(`**Full:** ${safeUrl(img.imageUrl)}`);
        if (img.thumbnail250) lines.push(`**250px:** ${safeUrl(img.thumbnail250)}`);
        if (img.thumbnail500) lines.push(`**500px:** ${safeUrl(img.thumbnail500)}`);
        if (img.thumbnail1200) lines.push(`**1200px:** ${safeUrl(img.thumbnail1200)}`);
        if (typeof img.approved === 'boolean')
          lines.push(`**Approved:** ${img.approved ? 'yes' : 'no'}`);
        if (img.comment) lines.push(`**Comment:** ${safeText(img.comment)}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * @fileoverview musicbrainz_get_release_group — release-group ("the album" above
 * specific pressings) by MBID: primary + secondary type, first-release date,
 * artist credit, the list of releases (editions), tags/genres, and cover-art
 * availability. The embedded releases list is capped at one page by the lookup
 * endpoint — musicbrainz_browse_entities (release by release-group) gives the
 * complete set. Use musicbrainz_get_release for a specific edition's tracklist.
 *
 * WS/2 carries no cover-art stub for release-groups (only releases get one), so
 * availability comes from the Cover Art Archive release-group lookup — the one
 * musicbrainz_get_cover_art makes — run concurrently with the WS/2 lookup and
 * bounded, since it is best-effort: when it fails, `coverArt` is omitted and the
 * notice says so, rather than reporting `exists: false` for art never checked.
 * @module mcp-server/tools/definitions/get-release-group.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCoverArtService } from '@/services/cover-art/cover-art-service.js';
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import type { RawCoverArtImage, RawReleaseGroup } from '@/services/musicbrainz/types.js';
import {
  ArtistCreditSchema,
  artistCreditString,
  CoverArtStubSchema,
  classifyMbidError,
  MBID_EXAMPLE,
  normalizeArtistCredits,
  normalizeTags,
  renderArtistCredits,
  renderCoverArtStub,
  renderTags,
  safeText,
  TagSchema,
} from './_shared.js';

const ReleaseRefSchema = z
  .object({
    mbid: z.string().describe('Release MBID — chain to musicbrainz_get_release for the tracklist.'),
    title: z.string().describe('Release (edition) title.'),
    date: z.string().optional().describe('Release date. Omitted when absent.'),
    country: z.string().optional().describe('Release country code. Omitted when absent.'),
    status: z
      .string()
      .optional()
      .describe('Release status (Official, Promotion, …). Omitted when absent.'),
    disambiguation: z.string().optional().describe('Short qualifier. Omitted when absent.'),
  })
  .describe('A release (edition) within the release-group.');

/** One-page cap for the releases (editions) embedded in a release-group lookup. */
const LOOKUP_PAGE_CAP = 25;

/** Bounds on the best-effort Cover Art Archive lookup: one attempt, a short timeout. */
const COVER_ART_LOOKUP_BOUNDS = { timeoutMs: 5_000, maxRetries: 0 } as const;

/** Summarize the archive's image index (empty after a 404) into the availability stub. */
function coverArtFromImages(images: RawCoverArtImage[]): z.infer<typeof CoverArtStubSchema> {
  return {
    exists: images.length > 0,
    count: images.length,
    front: images.some((image) => image.front === true),
    back: images.some((image) => image.back === true),
  };
}

export const getReleaseGroupTool = tool('musicbrainz_get_release_group', {
  title: 'musicbrainz-mcp-server: get release group',
  description:
    'Release-group ("the album" above specific pressings) by MBID: primary type (Album/Single/EP) and secondary types (Live/Compilation), first-release date, artist credit, the list of releases (editions), tags/genres, and cover-art availability from the Cover Art Archive (image count and front/back flags for the release-group\'s representative release — the art musicbrainz_get_cover_art returns; use that tool for the image URLs). The embedded releases list is capped at one page (25); for the complete set of editions, call musicbrainz_browse_entities with target_type=release and link.release-group. For a specific edition\'s tracklist, take a release MBID from the releases list and call musicbrainz_get_release.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_mbid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The MBID is malformed or the all-zeros sentinel (MusicBrainz returns HTTP 400).',
      recovery: `MBID must be a 36-character UUID (e.g. ${MBID_EXAMPLE}). Use musicbrainz_search_entities (entity_type=release-group) to find one from a title.`,
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The MBID is well-formed but no release-group exists with it (MusicBrainz returns HTTP 404).',
      recovery:
        'No release-group exists with that MBID. Verify the ID, or search by title with musicbrainz_search_entities.',
    },
  ],

  input: z.object({
    mbid: z.string().describe('Release-group MBID (36-character UUID).'),
  }),

  output: z.object({
    mbid: z.string().describe('Release-group MBID.'),
    title: z.string().describe('Release-group title.'),
    disambiguation: z.string().optional().describe('Short qualifier. Omitted when absent.'),
    primaryType: z
      .string()
      .optional()
      .describe('Primary type (Album, Single, EP, Broadcast, Other). Omitted when absent.'),
    secondaryTypes: z
      .array(z.string())
      .optional()
      .describe('Secondary types (Live, Compilation, Soundtrack, …). Omitted when none.'),
    firstReleaseDate: z
      .string()
      .optional()
      .describe('Earliest release date across all editions. Omitted when absent.'),
    artistCredit: z.array(ArtistCreditSchema).describe('Credited artists (may be empty).'),
    artistCreditString: z
      .string()
      .describe('Display string of the artist credit with join phrases.'),
    releases: z
      .array(ReleaseRefSchema)
      .describe(
        'Releases (editions) in this group (one page; may be empty or capped — use browse for all).',
      ),
    tags: z.array(TagSchema).describe('Community tags/genres (may be empty).'),
    coverArt: CoverArtStubSchema.optional().describe(
      "Cover-art availability from the Cover Art Archive: the images of the release-group's representative release, the same art musicbrainz_get_cover_art returns (exists: false with count 0 when the archive has none). Omitted when the archive lookup could not complete — the notice says so.",
    ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the releases list hit the one-page cap and more editions exist. Absent when the full set fit in one page.',
      ),
    shown: z
      .number()
      .optional()
      .describe('Number of releases returned. Absent when not truncated.'),
    cap: z
      .number()
      .optional()
      .describe('The one-page cap that was applied. Absent when not truncated.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Present when the releases list was capped (how to fetch the complete set of editions) and/or when cover-art availability could not be checked (why coverArt is omitted).',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_get_release_group', { mbid: input.mbid });
    const service = getMusicBrainzService();

    // Different host, outside the MusicBrainz rate limiter — start it first so it
    // overlaps the WS/2 lookup. Settled into a value (undefined on failure) so a
    // WS/2 error thrown below leaves no rejected promise unobserved.
    const coverArtPending = getCoverArtService()
      .getImages('release-group', input.mbid, ctx, {
        signal: ctx.signal,
        ...COVER_ART_LOOKUP_BOUNDS,
      })
      .then(
        (lookup) => coverArtFromImages(lookup.images ?? []),
        (error: unknown) => {
          ctx.log.warning('Cover Art Archive lookup failed; coverArt omitted', {
            mbid: input.mbid,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        },
      );

    let raw: RawReleaseGroup;
    try {
      raw = await service.lookup<RawReleaseGroup>(
        'release-group',
        input.mbid,
        { inc: ['releases', 'artist-credits', 'tags', 'genres'] },
        ctx,
        { signal: ctx.signal },
      );
    } catch (error: unknown) {
      const reason = classifyMbidError(error);
      if (reason === 'invalid_mbid')
        throw ctx.fail('invalid_mbid', undefined, {
          ...ctx.recoveryFor('invalid_mbid'),
          mbid: input.mbid,
        });
      if (reason === 'entity_not_found')
        throw ctx.fail('entity_not_found', undefined, {
          ...ctx.recoveryFor('entity_not_found'),
          mbid: input.mbid,
        });
      throw error;
    }

    const credits = normalizeArtistCredits(raw['artist-credit']);
    const releases = (raw.releases ?? []).map((r) => ({
      mbid: r.id,
      title: r.title ?? '',
      ...(r.date ? { date: r.date } : {}),
      ...(r.country ? { country: r.country } : {}),
      ...(r.status ? { status: r.status } : {}),
      ...(r.disambiguation ? { disambiguation: r.disambiguation } : {}),
    }));

    const coverArt = await coverArtPending;

    // `notice` is last-wins, so both sources compose into one string.
    const truncated = releases.length >= LOOKUP_PAGE_CAP;
    const notice = [
      truncated
        ? `Releases capped at ${LOOKUP_PAGE_CAP}. Call musicbrainz_browse_entities (target_type=release, link.release-group=${input.mbid}) to enumerate the complete set of editions.`
        : undefined,
      coverArt
        ? undefined
        : 'Cover-art availability could not be checked (the Cover Art Archive lookup failed), so coverArt is omitted; call musicbrainz_get_cover_art with entity_type=release-group to retry.',
    ]
      .filter(Boolean)
      .join(' ');
    if (truncated) {
      ctx.enrich.truncated({ shown: releases.length, cap: LOOKUP_PAGE_CAP, guidance: notice });
    } else if (notice) {
      ctx.enrich.notice(notice);
    }

    return {
      mbid: raw.id,
      title: raw.title ?? '',
      ...(raw.disambiguation ? { disambiguation: raw.disambiguation } : {}),
      ...(raw['primary-type'] ? { primaryType: raw['primary-type'] } : {}),
      ...(raw['secondary-types']?.length ? { secondaryTypes: raw['secondary-types'] } : {}),
      ...(raw['first-release-date'] ? { firstReleaseDate: raw['first-release-date'] } : {}),
      artistCredit: credits,
      artistCreditString: artistCreditString(credits),
      releases,
      tags: normalizeTags(raw.tags ?? raw.genres),
      ...(coverArt ? { coverArt } : {}),
    };
  },

  format: (result) => {
    const lines = [
      `## ${safeText(result.title)}${result.disambiguation ? ` (${safeText(result.disambiguation)})` : ''}`,
    ];
    lines.push(`**MBID:** ${result.mbid}`);
    lines.push(`**Artist:** ${safeText(result.artistCreditString)}`);
    const types = [result.primaryType, ...(result.secondaryTypes ?? [])]
      .filter(Boolean)
      .map((t) => safeText(t as string))
      .join(', ');
    if (types) lines.push(`**Type:** ${types}`);
    if (result.firstReleaseDate) lines.push(`**First release:** ${result.firstReleaseDate}`);
    if (result.coverArt) lines.push(renderCoverArtStub(result.coverArt));
    const tags = renderTags(result.tags);
    if (tags) lines.push(tags);
    lines.push(...renderArtistCredits(result.artistCredit));
    if (result.releases.length) {
      lines.push('', `### Releases (${result.releases.length})`);
      for (const r of result.releases) {
        const meta = [r.date, r.country, r.status ? safeText(r.status) : null]
          .filter(Boolean)
          .join(', ');
        const dis = r.disambiguation ? ` [${safeText(r.disambiguation)}]` : '';
        lines.push(`- **${safeText(r.title)}**${dis}${meta ? ` (${meta})` : ''} — ${r.mbid}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

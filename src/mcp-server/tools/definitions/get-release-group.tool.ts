/**
 * @fileoverview musicbrainz_get_release_group — release-group ("the album" above
 * specific pressings) by MBID: primary + secondary type, first-release date,
 * artist credit, the list of releases (editions), tags/genres, and whether cover
 * art exists. The embedded releases list is capped at one page by the lookup
 * endpoint — musicbrainz_browse_entities (release by release-group) gives the
 * complete set. Use musicbrainz_get_release for a specific edition's tracklist.
 * @module mcp-server/tools/definitions/get-release-group.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import type { RawReleaseGroup } from '@/services/musicbrainz/types.js';
import {
  ArtistCreditSchema,
  artistCreditString,
  CoverArtStubSchema,
  classifyMbidError,
  MBID_EXAMPLE,
  normalizeArtistCredits,
  normalizeCoverArtStub,
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

export const getReleaseGroupTool = tool('musicbrainz_get_release_group', {
  title: 'musicbrainz-mcp-server: get release group',
  description:
    'Release-group ("the album" above specific pressings) by MBID: primary type (Album/Single/EP) and secondary types (Live/Compilation), first-release date, artist credit, the list of releases (editions), tags/genres, and a cover-art availability flag from the WS/2 payload (use musicbrainz_get_cover_art for actual image URLs). The embedded releases list is capped at one page (25); for the complete set of editions, call musicbrainz_browse_entities with target_type=release and link.release-group. For a specific edition\'s tracklist, take a release MBID from the releases list and call musicbrainz_get_release.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_mbid',
      code: JsonRpcErrorCode.InvalidParams,
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
    coverArt: CoverArtStubSchema.describe(
      'Whether cover art exists (availability stub from WS/2).',
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
      .describe('How to fetch the complete list of editions when truncated.'),
  },

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_get_release_group', { mbid: input.mbid });
    const service = getMusicBrainzService();

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
      if (reason)
        throw ctx.fail(reason, undefined, { ...ctx.recoveryFor(reason), mbid: input.mbid });
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

    if (releases.length >= LOOKUP_PAGE_CAP) {
      ctx.enrich.truncated({ shown: releases.length, cap: LOOKUP_PAGE_CAP });
      ctx.enrich.notice(
        `Releases capped at ${LOOKUP_PAGE_CAP}. Call musicbrainz_browse_entities (target_type=release, link.release-group=${input.mbid}) to enumerate the complete set of editions.`,
      );
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
      coverArt: normalizeCoverArtStub(raw['cover-art-archive']),
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
    lines.push(renderCoverArtStub(result.coverArt));
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

/**
 * @fileoverview musicbrainz_get_release — one edition's detail by MBID:
 * paged media (tracks → recordings with lengths and MBIDs), label + catalog
 * number, barcode, country, release date, format, packaging, text representation,
 * and a cover-art availability stub.
 * @module mcp-server/tools/definitions/get-release.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import type { RawRelease } from '@/services/musicbrainz/types.js';
import {
  ArtistCreditSchema,
  artistCreditString,
  CoverArtStubSchema,
  classifyMbidError,
  formatDuration,
  MBID_EXAMPLE,
  MbidInput,
  normalizeArtistCredits,
  normalizeCoverArtStub,
  renderArtistCredits,
  renderCoverArtStub,
  safeText,
} from './_shared.js';

const TrackSchema = z
  .object({
    position: z.number().optional().describe('Track position on the medium. Omitted when absent.'),
    number: z
      .string()
      .optional()
      .describe('Printed track number (may differ from position). Omitted when absent.'),
    title: z.string().describe('Track title.'),
    length: z.string().optional().describe('Track length as m:ss. Omitted when unknown.'),
    recordingId: z
      .string()
      .optional()
      .describe('Recording MBID — chain to musicbrainz_get_recording. Omitted when absent.'),
  })
  .describe('A track on a medium, linked to its underlying recording.');

const MediumSchema = z
  .object({
    position: z
      .number()
      .optional()
      .describe('Medium position in the release (disc 1, 2, …). Omitted when absent.'),
    format: z
      .string()
      .optional()
      .describe('Medium format (CD, Vinyl, Digital Media, …). Omitted when unknown.'),
    title: z
      .string()
      .optional()
      .describe('Medium title, when the disc is named. Omitted when absent.'),
    trackCount: z
      .number()
      .optional()
      .describe('Number of tracks on the medium. Omitted when absent.'),
    tracks: z.array(TrackSchema).describe('Tracks on this medium (may be empty).'),
  })
  .describe('One physical/digital medium (disc) of the release.');

const LabelInfoSchema = z
  .object({
    labelId: z
      .string()
      .optional()
      .describe('Label MBID — chain to musicbrainz_get_label. Omitted when absent.'),
    labelName: z.string().optional().describe('Label name. Omitted when absent.'),
    catalogNumber: z
      .string()
      .optional()
      .describe('Catalog number on this release. Omitted when absent.'),
  })
  .describe('Label + catalog-number pairing for the release.');

export const getReleaseTool = tool('musicbrainz_get_release', {
  title: 'musicbrainz-mcp-server: get release',
  description:
    'One edition by MBID: ordered media with tracks, lengths and recording MBIDs, label + catalog number, barcode, country, release date, packaging, text representation, and a cover-art availability stub. media_offset (default 0) and media_limit (default 20, no maximum) select whole media after normalization; mediaTotal and trackTotal describe the full release. Follow the notice to retrieve remaining media. The release resource retains the complete raw tracklist. Track lengths are m:ss. For image URLs, call musicbrainz_get_cover_art.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_mbid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The MBID is malformed or the all-zeros sentinel (rejected before fetch), or MusicBrainz rejects it with HTTP 400.',
      recovery: `MBID must be a 36-character UUID (e.g. ${MBID_EXAMPLE}). Use musicbrainz_search_entities (entityType=release) to find one from a title.`,
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The MBID is well-formed but no release exists with it (MusicBrainz returns HTTP 404).',
      recovery:
        'No release exists with that MBID. Verify the ID, or search by title with musicbrainz_search_entities.',
    },
  ],

  input: z.object({
    mbid: MbidInput.describe(
      'Release MBID (hyphenated hexadecimal UUID; surrounding whitespace and uppercase accepted).',
    ),
    media_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based medium offset in release order (default 0).'),
    media_limit: z
      .number()
      .int()
      .min(1)
      .default(20)
      .describe('Maximum whole media returned (default 20; no upper bound).'),
  }),

  output: z.object({
    mbid: z.string().describe('Release MBID.'),
    title: z.string().describe('Release title.'),
    disambiguation: z.string().optional().describe('Short qualifier. Omitted when absent.'),
    artistCredit: z.array(ArtistCreditSchema).describe('Credited artists (may be empty).'),
    artistCreditString: z
      .string()
      .describe('Display string of the artist credit with join phrases.'),
    status: z
      .string()
      .optional()
      .describe('Release status (Official, Promotion, Bootleg, …). Omitted when absent.'),
    date: z.string().optional().describe('Release date. Omitted when absent.'),
    country: z.string().optional().describe('Release country code. Omitted when absent.'),
    barcode: z
      .string()
      .optional()
      .describe(
        'Barcode (UPC/EAN). Omitted when absent; empty string upstream means "known to have none".',
      ),
    packaging: z
      .string()
      .optional()
      .describe('Packaging type (Jewel Case, Digipak, …). Omitted when absent.'),
    language: z
      .string()
      .optional()
      .describe('Text-representation language code. Omitted when absent.'),
    script: z.string().optional().describe('Text-representation script code. Omitted when absent.'),
    releaseGroupId: z
      .string()
      .optional()
      .describe(
        'Parent release-group MBID — chain to musicbrainz_get_release_group. Omitted when absent.',
      ),
    labelInfo: z.array(LabelInfoSchema).describe('Label / catalog-number pairings (may be empty).'),
    mediaOffset: z.number().describe('Effective zero-based medium offset.'),
    mediaTotal: z.number().describe('Exact number of media in the whole normalized release.'),
    trackTotal: z
      .number()
      .describe(
        'Exact number of track occurrences in the whole normalized release, independent of upstream trackCount.',
      ),
    media: z
      .array(MediumSchema)
      .describe(
        'Selected media in release order, with complete tracklists for each medium (may be empty).',
      ),
    coverArt: CoverArtStubSchema.describe(
      'Whether cover art exists (availability stub from WS/2).',
    ),
  }),

  enrichment: {
    truncated: z.boolean().optional().describe('True when media remain after this nonempty page.'),
    shown: z.number().optional().describe('Number of media returned when more remain.'),
    cap: z.number().optional().describe('Requested media limit when more remain.'),
    notice: z.string().optional().describe('Next media_offset, exhaustion, or no-media guidance.'),
  },

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_get_release', { mbid: input.mbid });
    const service = getMusicBrainzService();

    let raw: RawRelease;
    try {
      raw = await service.lookup<RawRelease>(
        'release',
        input.mbid,
        { inc: ['recordings', 'artist-credits', 'labels', 'release-groups'] },
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

    const credits = normalizeArtistCredits(raw['artist-credit']);
    const media = (raw.media ?? []).map((m) => ({
      ...(typeof m.position === 'number' ? { position: m.position } : {}),
      ...(m.format ? { format: m.format } : {}),
      ...(m.title ? { title: m.title } : {}),
      ...(typeof m['track-count'] === 'number' ? { trackCount: m['track-count'] } : {}),
      tracks: (m.tracks ?? []).map((t) => {
        const length = formatDuration(t.length ?? t.recording?.length);
        return {
          ...(typeof t.position === 'number' ? { position: t.position } : {}),
          ...(t.number ? { number: t.number } : {}),
          title: t.title ?? t.recording?.title ?? '',
          ...(length ? { length } : {}),
          ...(t.recording?.id ? { recordingId: t.recording.id } : {}),
        };
      }),
    }));

    const labelInfo = (raw['label-info'] ?? []).map((li) => ({
      ...(li.label?.id ? { labelId: li.label.id } : {}),
      ...(li.label?.name ? { labelName: li.label.name } : {}),
      ...(li['catalog-number'] ? { catalogNumber: li['catalog-number'] } : {}),
    }));

    const mediaTotal = media.length;
    const trackTotal = media.reduce((total, medium) => total + medium.tracks.length, 0);
    const page = media.slice(input.media_offset, input.media_offset + input.media_limit);
    const nextOffset = input.media_offset + page.length;
    if (page.length > 0 && nextOffset < mediaTotal) {
      ctx.enrich({ truncated: true, shown: page.length, cap: input.media_limit });
      ctx.enrich.notice(
        `Showing ${page.length} of ${mediaTotal} media at media_offset=${input.media_offset}. Continue with musicbrainz_get_release (mbid=${raw.id}, media_offset=${nextOffset}, media_limit=${input.media_limit}).`,
      );
    } else if (page.length === 0) {
      ctx.enrich.notice(
        mediaTotal === 0
          ? 'No media are present in this release.'
          : `Media page exhausted at media_offset=${input.media_offset}; this release has ${mediaTotal} media and ${trackTotal} tracks.`,
      );
    }

    return {
      mbid: raw.id,
      title: raw.title ?? '',
      ...(raw.disambiguation ? { disambiguation: raw.disambiguation } : {}),
      artistCredit: credits,
      artistCreditString: artistCreditString(credits),
      ...(raw.status ? { status: raw.status } : {}),
      ...(raw.date ? { date: raw.date } : {}),
      ...(raw.country ? { country: raw.country } : {}),
      ...(raw.barcode ? { barcode: raw.barcode } : {}),
      ...(raw.packaging ? { packaging: raw.packaging } : {}),
      ...(raw['text-representation']?.language
        ? { language: raw['text-representation'].language }
        : {}),
      ...(raw['text-representation']?.script ? { script: raw['text-representation'].script } : {}),
      ...(raw['release-group']?.id ? { releaseGroupId: raw['release-group'].id } : {}),
      labelInfo,
      mediaOffset: input.media_offset,
      mediaTotal,
      trackTotal,
      media: page,
      coverArt: normalizeCoverArtStub(raw['cover-art-archive']),
    };
  },

  format: (result) => {
    const lines = [
      `## ${safeText(result.title)}${result.disambiguation ? ` (${safeText(result.disambiguation)})` : ''}`,
    ];
    lines.push(`**MBID:** ${result.mbid}`);
    lines.push(`**Artist:** ${safeText(result.artistCreditString)}`);
    if (result.status) lines.push(`**Status:** ${safeText(result.status)}`);
    if (result.date) lines.push(`**Date:** ${result.date}`);
    if (result.country) lines.push(`**Country:** ${result.country}`);
    if (result.barcode) lines.push(`**Barcode:** ${safeText(result.barcode)}`);
    if (result.packaging) lines.push(`**Packaging:** ${safeText(result.packaging)}`);
    if (result.language || result.script) {
      lines.push(`**Text:** ${[result.language, result.script].filter(Boolean).join(' / ')}`);
    }
    if (result.releaseGroupId) lines.push(`**Release group:** ${result.releaseGroupId}`);
    lines.push(renderCoverArtStub(result.coverArt));
    if (result.labelInfo.length) {
      lines.push(
        `**Labels:** ${result.labelInfo
          .map(
            (li) =>
              `${li.labelName ? safeText(li.labelName) : '?'}${li.labelId ? ` (${li.labelId})` : ''}${li.catalogNumber ? ` cat# ${safeText(li.catalogNumber)}` : ''}`,
          )
          .join(', ')}`,
      );
    }
    lines.push(...renderArtistCredits(result.artistCredit));
    lines.push(
      `**Tracklist:** ${result.mediaTotal} media, ${result.trackTotal} tracks (offset: ${result.mediaOffset}, shown: ${result.media.length})`,
    );
    for (const m of result.media) {
      const trackCount = typeof m.trackCount === 'number' ? ` (${m.trackCount} tracks)` : '';
      lines.push(
        '',
        `### Medium ${m.position ?? ''}${m.format ? ` — ${safeText(m.format)}` : ''}${m.title ? ` "${safeText(m.title)}"` : ''}${trackCount}`.trim(),
      );
      for (const t of m.tracks) {
        const posLabel = typeof t.position === 'number' ? `#${t.position}` : '';
        const num =
          t.number && t.number !== String(t.position) ? ` (printed ${safeText(t.number)})` : '';
        lines.push(
          `${posLabel || (t.number ? safeText(t.number) : '?')}${num}. ${safeText(t.title)}${t.length ? ` (${t.length})` : ''}${t.recordingId ? ` — ${t.recordingId}` : ''}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

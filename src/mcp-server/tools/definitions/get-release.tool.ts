/**
 * @fileoverview musicbrainz_get_release — one edition's full detail by MBID:
 * tracklist (media → tracks → recordings with lengths and MBIDs), label + catalog
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
    "One edition's full detail by MBID: the tracklist (media → tracks → recordings with lengths and recording MBIDs), label + catalog number, barcode, country, release date, format, packaging, text representation (language/script), and a cover-art availability stub. Track lengths are rendered m:ss (stored as milliseconds upstream). For the actual cover image URLs, call musicbrainz_get_cover_art with this release MBID.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_mbid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The MBID is malformed or the all-zeros sentinel (MusicBrainz returns HTTP 400).',
      recovery: `MBID must be a 36-character UUID (e.g. ${MBID_EXAMPLE}). Use musicbrainz_search_entities (entity_type=release) to find one from a title.`,
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
    mbid: z.string().describe('Release MBID (36-character UUID).'),
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
    media: z.array(MediumSchema).describe('Media (discs) with their tracklists (may be empty).'),
    coverArt: CoverArtStubSchema.describe(
      'Whether cover art exists (availability stub from WS/2).',
    ),
  }),

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
      if (reason)
        throw ctx.fail(reason, undefined, { ...ctx.recoveryFor(reason), mbid: input.mbid });
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
      media,
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

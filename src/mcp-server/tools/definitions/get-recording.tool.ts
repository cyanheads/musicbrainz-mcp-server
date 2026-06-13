/**
 * @fileoverview musicbrainz_get_recording — recording (a specific performance/
 * track) by MBID: length, artist credits, ISRCs, the releases it appears on, the
 * work(s) it performs, and performance/production relationships (who played,
 * produced, engineered, conducted — with role and credited artist MBID).
 * @module mcp-server/tools/definitions/get-recording.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import type { RawRecording } from '@/services/musicbrainz/types.js';
import {
  ArtistCreditSchema,
  artistCreditString,
  classifyMbidError,
  ExternalLinkSchema,
  formatDuration,
  MBID_EXAMPLE,
  normalizeArtistCredits,
  normalizeRelations,
  RelationSchema,
  renderArtistCredits,
  renderExternalLinks,
  renderRelationships,
  safeText,
} from './_shared.js';

const ReleaseAppearanceSchema = z
  .object({
    mbid: z.string().describe('Release MBID — chain to musicbrainz_get_release.'),
    title: z.string().describe('Release title.'),
    date: z.string().optional().describe('Release date. Omitted when absent.'),
    country: z.string().optional().describe('Release country code. Omitted when absent.'),
  })
  .describe('A release this recording appears on.');

export const getRecordingTool = tool('musicbrainz_get_recording', {
  title: 'musicbrainz-mcp-server: get recording',
  description:
    'Recording (a specific performance/track, distinct from the abstract work) by MBID: length, artist credits, ISRCs, the releases it appears on, the work(s) it performs (work-rels — chain to musicbrainz_get_work), and performance/production relationships (who played, produced, engineered, conducted — each with the role and the credited artist MBID). Relationships are capped at one page; for a heavily-covered recording call musicbrainz_browse_entities with target_type=recording and link.work.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_mbid',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The MBID is malformed or the all-zeros sentinel (MusicBrainz returns HTTP 400).',
      recovery: `MBID must be a 36-character UUID (e.g. ${MBID_EXAMPLE}). Use musicbrainz_search_entities (entity_type=recording) to find one from a title.`,
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The MBID is well-formed but no recording exists with it (MusicBrainz returns HTTP 404).',
      recovery:
        'No recording exists with that MBID. Verify the ID, or search by title with musicbrainz_search_entities.',
    },
  ],

  input: z.object({
    mbid: z.string().describe('Recording MBID (36-character UUID).'),
    inc_relationships: z
      .boolean()
      .default(true)
      .describe(
        'Include performance/production relationships (performers, producers, engineers) and work-rels.',
      ),
  }),

  output: z.object({
    mbid: z.string().describe('Recording MBID.'),
    title: z.string().describe('Recording title.'),
    disambiguation: z.string().optional().describe('Short qualifier. Omitted when absent.'),
    length: z.string().optional().describe('Recording length as m:ss. Omitted when unknown.'),
    artistCredit: z.array(ArtistCreditSchema).describe('Credited artists (may be empty).'),
    artistCreditString: z
      .string()
      .describe('Display string of the artist credit with join phrases.'),
    isrcs: z.array(z.string()).describe('ISRCs assigned to this recording (may be empty).'),
    firstReleaseDate: z
      .string()
      .optional()
      .describe('Earliest release date for this recording. Omitted when absent.'),
    releases: z
      .array(ReleaseAppearanceSchema)
      .describe('Releases this recording appears on (may be empty).'),
    relationships: z
      .array(RelationSchema)
      .describe('Performance/production relationships and work-rels (may be empty).'),
    externalLinks: z
      .array(ExternalLinkSchema)
      .describe('External resource links (url-rels) (may be empty).'),
  }),

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_get_recording', { mbid: input.mbid });
    const service = getMusicBrainzService();

    const inc = ['artist-credits', 'releases', 'isrcs'];
    if (input.inc_relationships) inc.push('artist-rels', 'work-rels', 'url-rels');

    let raw: RawRecording;
    try {
      raw = await service.lookup<RawRecording>('recording', input.mbid, { inc }, ctx, {
        signal: ctx.signal,
      });
    } catch (error: unknown) {
      const reason = classifyMbidError(error);
      if (reason)
        throw ctx.fail(reason, undefined, { ...ctx.recoveryFor(reason), mbid: input.mbid });
      throw error;
    }

    const credits = normalizeArtistCredits(raw['artist-credit']);
    const { relationships, externalLinks } = normalizeRelations(raw.relations);
    const length = formatDuration(raw.length);
    const releases = (raw.releases ?? []).map((r) => ({
      mbid: r.id,
      title: r.title ?? '',
      ...(r.date ? { date: r.date } : {}),
      ...(r.country ? { country: r.country } : {}),
    }));

    return {
      mbid: raw.id,
      title: raw.title ?? '',
      ...(raw.disambiguation ? { disambiguation: raw.disambiguation } : {}),
      ...(length ? { length } : {}),
      artistCredit: credits,
      artistCreditString: artistCreditString(credits),
      isrcs: raw.isrcs ?? [],
      ...(raw['first-release-date'] ? { firstReleaseDate: raw['first-release-date'] } : {}),
      releases,
      relationships,
      externalLinks,
    };
  },

  format: (result) => {
    const lines = [
      `## ${safeText(result.title)}${result.disambiguation ? ` (${safeText(result.disambiguation)})` : ''}`,
    ];
    lines.push(`**MBID:** ${result.mbid}`);
    lines.push(`**Artist:** ${safeText(result.artistCreditString)}`);
    if (result.length) lines.push(`**Length:** ${result.length}`);
    if (result.firstReleaseDate) lines.push(`**First release:** ${result.firstReleaseDate}`);
    if (result.isrcs.length) lines.push(`**ISRCs:** ${result.isrcs.join(', ')}`);
    lines.push(...renderArtistCredits(result.artistCredit));
    if (result.releases.length) {
      lines.push('', `### Appears on (${result.releases.length})`);
      for (const r of result.releases) {
        const meta = [r.date, r.country].filter(Boolean).join(', ');
        lines.push(`- **${safeText(r.title)}**${meta ? ` (${meta})` : ''} — ${r.mbid}`);
      }
    }
    lines.push(...renderRelationships(result.relationships));
    lines.push(...renderExternalLinks(result.externalLinks));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

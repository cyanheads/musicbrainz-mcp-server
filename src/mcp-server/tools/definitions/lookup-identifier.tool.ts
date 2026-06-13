/**
 * @fileoverview musicbrainz_lookup_identifier — resolve a standard identifier to
 * MusicBrainz entities without a name search: the deterministic path when you
 * already hold an ID. ISRC → recordings, ISWC → works, barcode → releases. The
 * output is a discriminated union on the resolved entity type, so the agent knows
 * what it is holding.
 * @module mcp-server/tools/definitions/lookup-identifier.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import type { RawRecording, RawRelease, RawWork } from '@/services/musicbrainz/types.js';
import { artistCreditString, formatDuration, normalizeArtistCredits, safeText } from './_shared.js';

/**
 * Classify an upstream error from a dedicated ISRC/ISWC endpoint: a malformed
 * identifier returns HTTP 400 (`InvalidParams`); a well-formed-but-unknown one
 * returns 404 (`NotFound`). Returns the contract reason or `null` (transient
 * failures bubble). Handlers call `ctx.fail(reason, …)` so the reason stays
 * lexically inside the handler for conformance lint.
 */
function classifyIdentifierError(
  error: unknown,
): 'invalid_identifier' | 'identifier_not_found' | null {
  if (!(error instanceof McpError)) return null;
  if (error.code === JsonRpcErrorCode.InvalidParams) return 'invalid_identifier';
  if (error.code === JsonRpcErrorCode.NotFound) return 'identifier_not_found';
  return null;
}

const RecordingHitSchema = z
  .object({
    mbid: z.string().describe('Recording MBID — chain to musicbrainz_get_recording.'),
    title: z.string().describe('Recording title.'),
    artistCredit: z.string().describe('Credited artist string.'),
    length: z.string().optional().describe('Recording length as m:ss. Omitted when unknown.'),
  })
  .describe('A recording carrying the looked-up ISRC.');

const WorkHitSchema = z
  .object({
    mbid: z.string().describe('Work MBID — chain to musicbrainz_get_work.'),
    title: z.string().describe('Work title.'),
    type: z.string().optional().describe('Work type. Omitted when absent.'),
  })
  .describe('A work carrying the looked-up ISWC.');

const ReleaseHitSchema = z
  .object({
    mbid: z.string().describe('Release MBID — chain to musicbrainz_get_release.'),
    title: z.string().describe('Release title.'),
    artistCredit: z.string().describe('Credited artist string.'),
    date: z.string().optional().describe('Release date. Omitted when absent.'),
    country: z.string().optional().describe('Release country code. Omitted when absent.'),
    score: z
      .number()
      .describe('Lucene relevance score, 0–100 (barcode is a search filter; exact = 100).'),
  })
  .describe('A release carrying the looked-up barcode.');

export const lookupIdentifierTool = tool('musicbrainz_lookup_identifier', {
  title: 'musicbrainz-mcp-server: lookup identifier',
  description:
    'Resolve a standard identifier to MusicBrainz entities without a name search — the deterministic path when you already hold an ID. id_type=isrc → recordings (a recording-level code, often shared by several recordings); id_type=iswc → works (a composition-level code); id_type=barcode → releases (UPC/EAN). ISRC and ISWC hit dedicated exact endpoints; barcode is a Lucene search filter so results are ranked (exact match scores 100). The output kind field tells you which entity type came back.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'identifier_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The identifier is well-formed but resolves to zero entities.',
      recovery:
        'No entity carries that identifier. Check the value, or search by name with musicbrainz_search_entities.',
    },
    {
      reason: 'invalid_identifier',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The ISRC/ISWC is malformed (the dedicated endpoint returns HTTP 400).',
      recovery:
        'ISRC is 12 chars (e.g. USRC17607839); ISWC is T- followed by 10 digits (e.g. T-345246800-1). Verify the format.',
    },
  ],

  input: z.object({
    id_type: z
      .enum(['isrc', 'iswc', 'barcode'])
      .describe('Which standard identifier: isrc (recording), iswc (work), or barcode (release).'),
    value: z
      .string()
      .min(1)
      .describe(
        'The identifier value. ISRC e.g. "USRC17607839"; ISWC e.g. "T-345246800-1"; barcode e.g. "075678164125".',
      ),
  }),

  // The resolved entity type varies by id_type, so `result` is a discriminated
  // union on `kind`. Wrapped in an object because the tool() output slot is a
  // ZodObject; `format()` validates each union arm separately for parity.
  output: z.object({
    result: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('recordings').describe('ISRC resolved to recordings.'),
            identifier: z.string().describe('The looked-up identifier value.'),
            recordings: z.array(RecordingHitSchema).describe('Recordings carrying this ISRC.'),
          })
          .describe('ISRC result arm: recordings carrying the ISRC.'),
        z
          .object({
            kind: z.literal('works').describe('ISWC resolved to works.'),
            identifier: z.string().describe('The looked-up identifier value.'),
            works: z.array(WorkHitSchema).describe('Works carrying this ISWC.'),
          })
          .describe('ISWC result arm: works carrying the ISWC.'),
        z
          .object({
            kind: z.literal('releases').describe('Barcode resolved to releases.'),
            identifier: z.string().describe('The looked-up identifier value.'),
            releases: z
              .array(ReleaseHitSchema)
              .describe('Releases carrying this barcode (ranked).'),
          })
          .describe('Barcode result arm: releases carrying the barcode.'),
      ])
      .describe('The resolved entities, discriminated by `kind` (recordings | works | releases).'),
  }),

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_lookup_identifier', { id_type: input.id_type, value: input.value });
    const service = getMusicBrainzService();

    if (input.id_type === 'isrc') {
      let envelope: { recordings?: RawRecording[] };
      try {
        envelope = await service.resolveIsrc(input.value, ctx, { signal: ctx.signal });
      } catch (error: unknown) {
        const reason = classifyIdentifierError(error);
        if (reason)
          throw ctx.fail(reason, `Identifier "${input.value}" — ${reason}.`, {
            ...ctx.recoveryFor(reason),
          });
        throw error;
      }
      const recordings = (envelope.recordings ?? []).map((r) => {
        const length = formatDuration(r.length);
        return {
          mbid: r.id,
          title: r.title ?? '',
          artistCredit: artistCreditString(normalizeArtistCredits(r['artist-credit'])),
          ...(length ? { length } : {}),
        };
      });
      if (recordings.length === 0) {
        throw ctx.fail('identifier_not_found', `No recording carries ISRC ${input.value}.`, {
          ...ctx.recoveryFor('identifier_not_found'),
        });
      }
      return { result: { kind: 'recordings' as const, identifier: input.value, recordings } };
    }

    if (input.id_type === 'iswc') {
      let envelope: { works?: RawWork[] };
      try {
        envelope = await service.resolveIswc(input.value, ctx, { signal: ctx.signal });
      } catch (error: unknown) {
        const reason = classifyIdentifierError(error);
        if (reason)
          throw ctx.fail(reason, `Identifier "${input.value}" — ${reason}.`, {
            ...ctx.recoveryFor(reason),
          });
        throw error;
      }
      const works = (envelope.works ?? []).map((w) => ({
        mbid: w.id,
        title: w.title ?? '',
        ...(w.type ? { type: w.type } : {}),
      }));
      if (works.length === 0) {
        throw ctx.fail('identifier_not_found', `No work carries ISWC ${input.value}.`, {
          ...ctx.recoveryFor('identifier_not_found'),
        });
      }
      return { result: { kind: 'works' as const, identifier: input.value, works } };
    }

    // barcode — Lucene search filter on releases (ranked, not a dedicated endpoint).
    const envelope = await service.search(
      'release',
      `barcode:${input.value}`,
      { limit: 25, offset: 0 },
      ctx,
      { signal: ctx.signal },
    );
    const releases = (envelope.releases ?? []).map((r: RawRelease) => ({
      mbid: r.id,
      title: r.title ?? '',
      artistCredit: artistCreditString(normalizeArtistCredits(r['artist-credit'])),
      ...(r.date ? { date: r.date } : {}),
      ...(r.country ? { country: r.country } : {}),
      score: typeof r.score === 'number' ? r.score : 0,
    }));
    if (releases.length === 0) {
      throw ctx.fail('identifier_not_found', `No release carries barcode ${input.value}.`, {
        ...ctx.recoveryFor('identifier_not_found'),
      });
    }
    return { result: { kind: 'releases' as const, identifier: input.value, releases } };
  },

  format: (output) => {
    const result = output.result;
    const lines: string[] = [`## Identifier lookup: ${safeText(result.identifier)}`];
    if (result.kind === 'recordings') {
      lines.push(`**Resolved to ${result.recordings.length} recording(s):**`);
      for (const r of result.recordings) {
        lines.push(
          `- **${safeText(r.title)}** — ${safeText(r.artistCredit)}${r.length ? ` (${r.length})` : ''} — ${r.mbid}`,
        );
      }
    } else if (result.kind === 'works') {
      lines.push(`**Resolved to ${result.works.length} work(s):**`);
      for (const w of result.works) {
        lines.push(
          `- **${safeText(w.title)}**${w.type ? ` (${safeText(w.type)})` : ''} — ${w.mbid}`,
        );
      }
    } else {
      lines.push(`**Resolved to ${result.releases.length} release(s):**`);
      for (const r of result.releases) {
        const meta = [r.date, r.country].filter(Boolean).join(', ');
        lines.push(
          `- **${safeText(r.title)}** — ${safeText(r.artistCredit)}${meta ? ` (${meta})` : ''} [score ${r.score}] — ${r.mbid}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

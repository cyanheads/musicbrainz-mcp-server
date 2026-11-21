/**
 * @fileoverview Shared release-edition metadata for discovery rows and release detail.
 * @module mcp-server/tools/definitions/release-edition
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { RawRelease } from '@/services/musicbrainz/types.js';
import { safeText } from './_shared.js';

export const LabelInfoSchema = z
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

export const ReleaseEventSchema = z
  .object({
    date: z.string().optional().describe('Event date, which may be partial. Omitted when unknown.'),
    country: z
      .string()
      .optional()
      .describe('ISO 3166-1 code of the event area. Omitted when unknown.'),
  })
  .describe('One dated or country-specific release event.');

export const ReleaseEditionSchema = z.object({
  labelInfo: z
    .array(LabelInfoSchema)
    .optional()
    .describe('Known label and catalog-number pairings. Omitted when none are known.'),
  formats: z
    .array(z.string())
    .optional()
    .describe('Known media formats in medium order. Omitted when none are known.'),
  trackCount: z
    .number()
    .optional()
    .describe('Reported release track count, or sum of all medium counts. Omitted when unknown.'),
  barcode: z
    .string()
    .optional()
    .describe('UPC/EAN. Empty means confirmed absent. Omitted when unknown.'),
  packaging: z.string().optional().describe('Packaging type. Omitted when unknown.'),
  releaseGroupId: z
    .string()
    .optional()
    .describe('Parent release-group MBID — chain to musicbrainz_get_release_group.'),
  releaseEvents: z
    .array(ReleaseEventSchema)
    .optional()
    .describe('Release dates and countries in upstream event order. Omitted when none are known.'),
});

/** Normalize each label row, retaining independently known names, IDs, and catalog numbers. */
export function mapLabelInfo(raw: RawRelease): z.infer<typeof LabelInfoSchema>[] {
  return (raw['label-info'] ?? []).map((li) => ({
    ...(li.label?.id ? { labelId: li.label.id } : {}),
    ...(li.label?.name ? { labelName: li.label.name } : {}),
    ...(li['catalog-number'] ? { catalogNumber: li['catalog-number'] } : {}),
  }));
}

/** Read each event's own date and country without falling back to the release scalars. */
export function mapReleaseEvents(raw: RawRelease): z.infer<typeof ReleaseEventSchema>[] {
  const events: z.infer<typeof ReleaseEventSchema>[] = [];
  for (const event of raw['release-events'] ?? []) {
    const country = event.area?.['iso-3166-1-codes']?.[0];
    if (!event.date && !country) continue;
    events.push({
      ...(event.date ? { date: event.date } : {}),
      ...(country ? { country } : {}),
    });
  }
  return events;
}

/** Project edition fields shared by release search, browse, and barcode lookup. */
export function mapReleaseEdition(raw: RawRelease): z.infer<typeof ReleaseEditionSchema> {
  const labelInfo = mapLabelInfo(raw).filter(
    (li) => li.labelId || li.labelName || li.catalogNumber,
  );
  const releaseEvents = mapReleaseEvents(raw);
  const media = raw.media ?? [];
  const formats = media
    .map((medium) => medium.format)
    .filter((format): format is string => Boolean(format));
  const counts = media.map((medium) => medium['track-count']);
  const trackCount =
    typeof raw['track-count'] === 'number'
      ? raw['track-count']
      : counts.length > 0 && counts.every((count) => typeof count === 'number')
        ? counts.reduce((sum, count) => sum + count, 0)
        : undefined;
  return {
    ...(labelInfo.length ? { labelInfo } : {}),
    ...(formats.length ? { formats } : {}),
    ...(trackCount === undefined ? {} : { trackCount }),
    ...(typeof raw.barcode === 'string' ? { barcode: raw.barcode } : {}),
    ...(raw.packaging ? { packaging: raw.packaging } : {}),
    ...(raw['release-group']?.id ? { releaseGroupId: raw['release-group'].id } : {}),
    ...(releaseEvents.length ? { releaseEvents } : {}),
  };
}

/** Render partial label rows, with a placeholder in the release detail view. */
export function renderLabelInfo(
  labelInfo: z.infer<typeof LabelInfoSchema>[],
  missingName?: '?',
): string {
  const labels = labelInfo.map((li) => {
    const name = li.labelName ? safeText(li.labelName) : missingName;
    const label =
      name === undefined ? li.labelId : `${name}${li.labelId ? ` (${li.labelId})` : ''}`;
    const catalogNumber = li.catalogNumber ? `cat# ${safeText(li.catalogNumber)}` : undefined;
    const parts = [label, catalogNumber];
    return (missingName ? parts.filter((part) => part !== undefined) : parts.filter(Boolean)).join(
      ' ',
    );
  });
  return (missingName ? labels : labels.filter(Boolean)).join(', ');
}

/** Render known dates and countries from ordered release events. */
export function renderReleaseEvents(events: z.infer<typeof ReleaseEventSchema>[]): string {
  return events
    .map(({ date, country }) =>
      date && country
        ? `${safeText(date)} (${safeText(country)})`
        : safeText(date ?? country ?? ''),
    )
    .join(', ');
}

/** Render pressing metadata as nested rows underneath a discovery hit. */
export function renderReleaseEdition(edition: z.infer<typeof ReleaseEditionSchema>): string[] {
  const lines: string[] = [];
  if (edition.labelInfo?.length) {
    lines.push(`  - **Labels:** ${renderLabelInfo(edition.labelInfo)}`);
  }
  if (edition.formats?.length)
    lines.push(`  - **Formats:** ${edition.formats.map(safeText).join(', ')}`);
  if (edition.trackCount !== undefined) lines.push(`  - **Track count:** ${edition.trackCount}`);
  if (edition.barcode !== undefined) {
    lines.push(
      `  - **Barcode:** ${edition.barcode === '' ? 'None (confirmed)' : safeText(edition.barcode)}`,
    );
  }
  if (edition.packaging) lines.push(`  - **Packaging:** ${safeText(edition.packaging)}`);
  if (edition.releaseGroupId) lines.push(`  - **Release group:** ${edition.releaseGroupId}`);
  if (edition.releaseEvents?.length) {
    lines.push(`  - **Release events:** ${renderReleaseEvents(edition.releaseEvents)}`);
  }
  return lines;
}

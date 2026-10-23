/**
 * @fileoverview Lookup-only release appearance completeness for recording tool and resource views.
 * @module services/musicbrainz/release-appearances
 */
import type { RawRecording } from './types.js';

/** Completeness evidence for the embedded upstream release page, without a count request. */
export interface ReleaseAppearanceSummary {
  cap: number;
  completeness: 'complete' | 'unknown' | 'truncated';
  notice: string;
  shown: number;
  totalCount?: number;
}

/** A short present page proves completeness; a full or absent page needs an upstream count. */
export function summarizeReleaseAppearances(
  raw: Pick<RawRecording, 'id' | 'releases' | 'release-count'>,
): ReleaseAppearanceSummary {
  const cap = 25;
  const shown = raw.releases?.length ?? 0;
  const totalCount = raw['release-count'] ?? (raw.releases && shown < cap ? shown : undefined);
  const completeness =
    totalCount === undefined ? 'unknown' : totalCount > shown ? 'truncated' : 'complete';
  return {
    shown,
    cap,
    completeness,
    ...(totalCount === undefined ? {} : { totalCount }),
    notice: `Enumerate release appearances with musicbrainz_browse_entities (target_type=release, link.recording=${raw.id}, offset=0). Start at offset=0 because the embedded page may use a different order from browse.`,
  };
}

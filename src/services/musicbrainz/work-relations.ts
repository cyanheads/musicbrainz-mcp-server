/**
 * @fileoverview Bounded work recording relationships shared by tool and resource views.
 * @module services/musicbrainz/work-relations
 */
import type { RawRelation } from './types.js';

/** Exact recording relationship count and disclosure for an actual server-side slice. */
export interface RecordingRelationshipSummary {
  cap?: number;
  notice?: string;
  shown?: number;
  totalCount: number;
  truncated?: true;
}

/** Keep the first 25 recording-target relations and every other relation, in upstream order. */
export function sliceWorkRelations(
  relations: RawRelation[] | undefined,
  mbid: string,
): {
  relations: RawRelation[];
  summary: RecordingRelationshipSummary;
} {
  const cap = 25;
  let totalCount = 0;
  const retained = (relations ?? []).filter((relation) => {
    if (relation['target-type'] !== 'recording') return true;
    totalCount++;
    return totalCount <= cap;
  });
  return {
    relations: retained,
    summary: {
      totalCount,
      ...(totalCount > cap
        ? {
            truncated: true,
            shown: cap,
            cap,
            notice: `Showing ${cap} of ${totalCount} recording relationships. Call musicbrainz_browse_entities (target_type=recording, link.work=${mbid}, limit=25, offset=0) to enumerate recording entities, then musicbrainz_get_recording for each recording's work relationship attributes and dates. Browse does not return performance relationship details.`,
          }
        : {}),
    },
  };
}

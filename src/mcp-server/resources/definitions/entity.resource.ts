/**
 * @fileoverview musicbrainz://{entity_type}/{mbid} — a single MusicBrainz entity
 * by type and MBID, returned as a stable injectable-context resource. Mirrors the
 * corresponding get_* tool with default `inc` sets. A convenience mirror for
 * clients that support resources; every entity is fully reachable through the
 * get_* tools, so tool-only clients lose nothing. No list() — the corpus is
 * millions of entities; discovery is via musicbrainz_search_entities.
 * @module mcp-server/resources/definitions/entity.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { MbidInput } from '@/mcp-server/tools/definitions/_shared.js';
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import { summarizeReleaseAppearances } from '@/services/musicbrainz/release-appearances.js';
import type { EntityType, RawRecording, RawRelation } from '@/services/musicbrainz/types.js';
import { sliceWorkRelations } from '@/services/musicbrainz/work-relations.js';

/** Default `inc` sets per entity type — the useful slice the get_* tools fetch. */
const DEFAULT_INC: Record<EntityType, string[]> = {
  artist: ['release-groups', 'artist-rels', 'url-rels', 'aliases', 'tags', 'genres'],
  'release-group': ['releases', 'artist-credits', 'tags', 'genres'],
  release: ['recordings', 'artist-credits', 'labels', 'release-groups'],
  recording: ['artist-credits', 'releases', 'isrcs', 'artist-rels', 'work-rels', 'url-rels'],
  work: ['artist-rels', 'work-rels', 'recording-rels', 'aliases', 'tags', 'genres', 'url-rels'],
  label: ['aliases', 'tags', 'genres', 'url-rels'],
};

const ENTITY_TYPES = ['artist', 'release-group', 'release', 'recording', 'work', 'label'] as const;

export const entityResource = resource('musicbrainz://{entity_type}/{mbid}', {
  name: 'musicbrainz-entity',
  title: 'musicbrainz-mcp-server: entity',
  description:
    'A MusicBrainz entity by type and MBID with default linked data. entity_type: artist, release-group, release, recording, work, label. Artist release-groups, release-group editions and recording release appearances embed one upstream page; labels embed no releases. Recording JSON includes releaseAppearanceSummary (shown, cap, completeness, optional exact totalCount and browse guidance from offset 0). Work JSON includes raw movement/arrangement relationships with direction, ordering-key and target disambiguation when supplied. Work recording relationships are sliced to 25 with recordingRelationshipSummary (exact relationship total and actual truncation). All other relationships and complete release tracklists are preserved; release-tool media windows do not apply here. Browse recording by work enumerates identities; musicbrainz_get_recording supplies work relationship attributes and dates.',
  mimeType: 'application/json',

  errors: [
    {
      reason: 'invalid_mbid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The MBID is malformed / all-zeros, or entity_type is not one of the six valid types.',
      recovery:
        'Use a 36-character UUID MBID and a valid entity_type (artist, release-group, release, recording, work, label).',
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The MBID is well-formed but no entity of that type exists with it.',
      recovery: 'Verify the MBID, or find it by name with the musicbrainz_search_entities tool.',
    },
  ],

  params: z.object({
    entity_type: z
      .enum(ENTITY_TYPES)
      .describe('Entity type: artist, release-group, release, recording, work, or label.'),
    mbid: MbidInput.describe(
      'Entity MBID (hyphenated hexadecimal UUID; surrounding whitespace and uppercase accepted).',
    ),
  }),

  async handler(params, ctx) {
    ctx.log.debug('musicbrainz entity resource', {
      entityType: params.entity_type,
      mbid: params.mbid,
    });
    const service = getMusicBrainzService();
    try {
      const raw = await service.lookup<RawRecording & Record<string, unknown>>(
        params.entity_type,
        params.mbid,
        { inc: DEFAULT_INC[params.entity_type] },
        ctx,
        { signal: ctx.signal },
      );
      if (params.entity_type === 'recording') {
        return { ...raw, releaseAppearanceSummary: summarizeReleaseAppearances(raw) };
      }
      if (params.entity_type !== 'work') return raw;
      const slice = sliceWorkRelations(raw.relations as RawRelation[] | undefined, String(raw.id));
      return { ...raw, relations: slice.relations, recordingRelationshipSummary: slice.summary };
    } catch (error: unknown) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.ValidationError) {
        throw ctx.fail('invalid_mbid', `Malformed MBID "${params.mbid}".`);
      }
      if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'entity_not_found',
          `No ${params.entity_type} exists with MBID ${params.mbid}.`,
        );
      }
      throw error;
    }
  },
});

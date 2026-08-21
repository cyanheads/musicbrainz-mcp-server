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
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import type { EntityType } from '@/services/musicbrainz/types.js';

/** Default `inc` sets per entity type — the useful slice the get_* tools fetch. */
const DEFAULT_INC: Record<EntityType, string[]> = {
  artist: ['release-groups', 'artist-rels', 'url-rels', 'aliases', 'tags', 'genres'],
  'release-group': ['releases', 'artist-credits', 'tags', 'genres'],
  release: ['recordings', 'artist-credits', 'labels', 'release-groups'],
  recording: ['artist-credits', 'releases', 'isrcs', 'artist-rels', 'work-rels', 'url-rels'],
  work: ['artist-rels', 'recording-rels', 'aliases', 'tags', 'genres', 'url-rels'],
  label: ['aliases', 'tags', 'genres', 'url-rels'],
};

const ENTITY_TYPES = ['artist', 'release-group', 'release', 'recording', 'work', 'label'] as const;

export const entityResource = resource('musicbrainz://{entity_type}/{mbid}', {
  name: 'musicbrainz-entity',
  title: 'musicbrainz-mcp-server: entity',
  description:
    "A single MusicBrainz entity by type and MBID, with default linked sub-resources folded in (mirrors the matching musicbrainz_get_* tool). entity_type ∈ artist, release-group, release, recording, work, label. Returns the raw MusicBrainz JSON record. For complete linked sets (a prolific artist's discography, a label's releases) use musicbrainz_browse_entities — embedded lists here are capped at one page.",
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
    mbid: z.string().describe('Entity MBID (36-character UUID).'),
  }),

  async handler(params, ctx) {
    ctx.log.debug('musicbrainz entity resource', {
      entityType: params.entity_type,
      mbid: params.mbid,
    });
    const service = getMusicBrainzService();
    try {
      return await service.lookup<Record<string, unknown>>(
        params.entity_type,
        params.mbid,
        { inc: DEFAULT_INC[params.entity_type] },
        ctx,
        { signal: ctx.signal },
      );
    } catch (error: unknown) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.ValidationError) {
        throw ctx.fail('invalid_mbid', `Malformed MBID "${params.mbid}".`, {
          ...ctx.recoveryFor('invalid_mbid'),
        });
      }
      if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'entity_not_found',
          `No ${params.entity_type} exists with MBID ${params.mbid}.`,
          {
            ...ctx.recoveryFor('entity_not_found'),
          },
        );
      }
      throw error;
    }
  },
});

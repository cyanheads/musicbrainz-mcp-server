/**
 * @fileoverview musicbrainz_browse_entities — paginate the COMPLETE set of
 * entities linked to a parent MBID: every release on a label, every release-group
 * by an artist, every recording of a work or release, every release in a group.
 * Enumerates entities rather than ordered tracks or performance relationship details.
 * @module mcp-server/tools/definitions/browse-entities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getMusicBrainzService,
  MusicBrainzService,
} from '@/services/musicbrainz/musicbrainz-service.js';
import type {
  BrowseEnvelope,
  BrowseLink,
  EntityType,
  RawArtist,
  RawLabel,
  RawRecording,
  RawRelease,
  RawReleaseGroup,
  RawWork,
} from '@/services/musicbrainz/types.js';
import {
  artistCreditString,
  classifyMbidError,
  formatDuration,
  MbidInput,
  normalizeArtistCredits,
  safeText,
} from './_shared.js';

const TARGET_TYPES = ['artist', 'release-group', 'release', 'recording', 'work', 'label'] as const;

/** Maps the `{type}-count` envelope key for each entity type. */
const COUNT_KEY: Record<EntityType, string> = {
  artist: 'artist-count',
  'release-group': 'release-group-count',
  release: 'release-count',
  recording: 'recording-count',
  work: 'work-count',
  label: 'label-count',
};

const EntityRefSchema = z
  .object({
    mbid: z.string().describe('Entity MBID — chain to the matching musicbrainz_get_* tool.'),
    name: z
      .string()
      .describe('Entity name (artist/label) or title (release-group/release/recording/work).'),
    disambiguation: z.string().optional().describe('Short qualifier. Omitted when absent.'),
    type: z.string().optional().describe('Entity subtype, where applicable. Omitted when absent.'),
    status: z
      .string()
      .optional()
      .describe(
        'Release status (e.g. Official or Bootleg). Omitted for other entity types or when absent.',
      ),
    artistCredit: z
      .string()
      .optional()
      .describe('Credited artist string, for release-group/release/recording. Omitted otherwise.'),
    date: z
      .string()
      .optional()
      .describe('First-release/release date, where applicable. Omitted when absent.'),
    country: z.string().optional().describe('Country code, where applicable. Omitted when absent.'),
    length: z
      .string()
      .optional()
      .describe('Recording length as m:ss. Omitted when not a recording / unknown.'),
  })
  .describe('A lightweight reference to a linked entity.');

function mapEntity(type: EntityType, raw: unknown): z.infer<typeof EntityRefSchema> {
  const base = raw as { id: string; disambiguation?: string };
  const disambiguation = base.disambiguation?.trim();
  const common = { mbid: base.id, ...(disambiguation ? { disambiguation } : {}) };

  if (type === 'artist' || type === 'label') {
    const e = raw as RawArtist | RawLabel;
    return {
      ...common,
      name: e.name ?? '',
      ...(e.type ? { type: e.type } : {}),
      ...(e.country ? { country: e.country } : {}),
    };
  }
  if (type === 'work') {
    const e = raw as RawWork;
    return { ...common, name: e.title ?? '', ...(e.type ? { type: e.type } : {}) };
  }
  if (type === 'recording') {
    const e = raw as RawRecording;
    const length = formatDuration(e.length);
    return {
      ...common,
      name: e.title ?? '',
      artistCredit: artistCreditString(normalizeArtistCredits(e['artist-credit'])),
      ...(length ? { length } : {}),
    };
  }
  const e = raw as RawReleaseGroup | RawRelease;
  const isReleaseGroup = type === 'release-group';
  const date = isReleaseGroup
    ? (e as RawReleaseGroup)['first-release-date']
    : (e as RawRelease).date;
  const subtype = isReleaseGroup ? (e as RawReleaseGroup)['primary-type'] : undefined;
  const status = !isReleaseGroup ? (e as RawRelease).status : undefined;
  return {
    ...common,
    name: e.title ?? '',
    ...(subtype ? { type: subtype } : {}),
    ...(status ? { status } : {}),
    artistCredit: artistCreditString(normalizeArtistCredits(e['artist-credit'])),
    ...(date ? { date } : {}),
    ...((e as RawRelease).country ? { country: (e as RawRelease).country as string } : {}),
  };
}

export const browseEntitiesTool = tool('musicbrainz_browse_entities', {
  title: 'musicbrainz-mcp-server: browse entities',
  description:
    'Paginate entities linked to one parent MBID: release-groups by artist; releases by artist, label, release-group, or recording; recordings by artist, work, or release; works by artist; artists/labels by area. Artist release-groups and release-group editions embed one upstream page in get_* lookups; use this tool for the complete entity set. Recording browse returns identities, not performance attributes/dates or ordered release tracks: use musicbrainz_get_recording for work relationships and musicbrainz_get_release for tracks. Provide exactly one valid parent link. offset pages to any depth; totalCount is the upstream entity total. Release rows carry status, other entity subtypes use type.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_link',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A parent key is unknown, aliases collide, not exactly one nonempty parent is supplied, or the MBID/parent combination is invalid.',
      recovery:
        'Provide exactly one parent key: artist, label, release-group, release, recording, work, or area. releaseGroup and release_group alias release-group; never combine aliases. Supply a 36-character hexadecimal UUID MBID valid for target_type.',
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The link MBID is well-formed but no such parent entity exists (HTTP 404).',
      recovery:
        'No parent entity exists with that MBID. Verify the ID with the matching musicbrainz_get_* tool or musicbrainz_search_entities.',
    },
  ],

  input: z.object({
    target_type: z.enum(TARGET_TYPES).describe('The entity type to enumerate (the children).'),
    link: z
      .object({
        artist: MbidInput.optional().describe(
          'Parent artist MBID (e.g. release-groups/recordings/releases by this artist).',
        ),
        label: MbidInput.optional().describe('Parent label MBID (releases on this label).'),
        'release-group': MbidInput.optional().describe(
          'Parent release-group MBID (releases in this group).',
        ),
        release: MbidInput.optional().describe(
          'Parent release MBID (recording entities in this edition, not ordered tracks).',
        ),
        releaseGroup: MbidInput.optional().describe(
          'Alias for release-group; use only one spelling.',
        ),
        release_group: MbidInput.optional().describe(
          'Alias for release-group; use only one spelling.',
        ),
        recording: MbidInput.optional().describe(
          'Parent recording MBID (releases containing this recording).',
        ),
        work: MbidInput.optional().describe('Parent work MBID (recordings of this work).'),
        area: MbidInput.optional().describe('Parent area MBID (artists/labels in this area).'),
      })
      .catchall(z.unknown())
      .describe(
        'Exactly one parent MBID. The valid key depends on target_type (see the description).',
      ),
    limit: z.number().int().min(1).max(100).default(25).describe('Page size (1–100).'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Result offset for deep pagination (0-based).'),
  }),

  output: z.object({
    targetType: z.string().describe('The entity type that was enumerated.'),
    linkType: z
      .string()
      .describe(
        'The parent link type used (artist, label, release-group, release, recording, work, or area).',
      ),
    linkMbid: z.string().describe('The parent MBID that was browsed.'),
    entities: z.array(EntityRefSchema).describe('This page of linked entities, in upstream order.'),
    offset: z.number().describe('The offset used for this page.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('True total number of linked entities upstream (the {type}-count field).'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more entities remain beyond this page (offset + shown < totalCount). Absent when the page is complete.',
      ),
    shown: z
      .number()
      .optional()
      .describe('Number of entities returned in this page. Absent when not truncated.'),
    cap: z
      .number()
      .optional()
      .describe('The page size that was applied. Absent when not truncated.'),
    notice: z
      .string()
      .optional()
      .describe('How to page further when results remain, or guidance when empty.'),
  },

  async handler(input, ctx) {
    ctx.log.info('musicbrainz_browse_entities', { target: input.target_type });
    const service = getMusicBrainzService();

    const acceptedKeys = [
      'artist',
      'label',
      'release-group',
      'release',
      'recording',
      'work',
      'area',
    ];
    const aliases = ['releaseGroup', 'release_group'];
    const unknownKeys = Object.keys(input.link).filter(
      (key) => !acceptedKeys.includes(key) && !aliases.includes(key),
    );
    if (unknownKeys.length) {
      throw ctx.fail(
        'invalid_link',
        `Unknown link key(s): ${unknownKeys.join(', ')}. Accepted keys: ${acceptedKeys.join(', ')}.`,
      );
    }
    const groupKeys = ['release-group', ...aliases].filter((key) => Object.hasOwn(input.link, key));
    if (groupKeys.length > 1) {
      throw ctx.fail(
        'invalid_link',
        `release-group alias collision: ${groupKeys.join(', ')}. Supply only one spelling.`,
      );
    }
    const normalizedLink = Object.fromEntries(
      Object.entries(input.link).map(([key, value]) => [
        aliases.includes(key) ? 'release-group' : key,
        value,
      ]),
    );
    const linkEntries = Object.entries(normalizedLink).filter(
      ([, v]) => typeof v === 'string' && v.length > 0,
    ) as [BrowseLink, string][];
    const first = linkEntries[0];
    if (linkEntries.length !== 1 || !first) {
      throw ctx.fail(
        'invalid_link',
        `Provide exactly one link MBID — received ${linkEntries.length}.`,
      );
    }
    const [linkType, suppliedMbid] = first;
    const linkMbid = suppliedMbid.trim().toLowerCase();

    let envelope: BrowseEnvelope;
    try {
      envelope = await service.browse(
        input.target_type,
        { link: linkType, linkMbid, limit: input.limit, offset: input.offset },
        ctx,
        { signal: ctx.signal },
      );
    } catch (error: unknown) {
      const reason = classifyMbidError(error);
      if (reason === 'invalid_mbid') {
        throw ctx.fail('invalid_link', `Malformed link MBID "${linkMbid}".`);
      }
      if (reason === 'entity_not_found') {
        throw ctx.fail('entity_not_found', `No ${linkType} exists with MBID ${linkMbid}.`);
      }
      throw error;
    }

    const key = MusicBrainzService.pluralKey(input.target_type);
    const rawEntities = (envelope[key] ?? []) as unknown[];
    const entities = rawEntities.map((e) => mapEntity(input.target_type, e));
    const totalCount = (envelope as Record<string, unknown>)[COUNT_KEY[input.target_type]] as
      | number
      | undefined;
    const total = typeof totalCount === 'number' ? totalCount : input.offset + entities.length;

    ctx.enrich.total(total);
    const remaining = total - (input.offset + entities.length);
    if (remaining > 0) {
      ctx.enrich.truncated({ shown: entities.length, cap: input.limit });
      ctx.enrich.notice(
        `${remaining} more linked entit${remaining === 1 ? 'y' : 'ies'} remain. Call again with offset=${input.offset + entities.length} to continue paging.`,
      );
    } else if (entities.length === 0) {
      ctx.enrich.notice(`No ${input.target_type} entities are linked to ${linkType} ${linkMbid}.`);
    }

    return {
      targetType: input.target_type,
      linkType,
      linkMbid,
      entities,
      offset: input.offset,
    };
  },

  format: (result) => {
    const lines = [
      `## Browse ${result.targetType} by ${result.linkType}`,
      `**Parent:** ${result.linkMbid} | **Offset:** ${result.offset} | **This page:** ${result.entities.length}`,
    ];
    for (const e of result.entities) {
      const meta = [
        e.type ? safeText(e.type) : null,
        e.status ? safeText(e.status) : null,
        e.artistCredit ? safeText(e.artistCredit) : null,
        e.date,
        e.country,
        e.length,
      ]
        .filter(Boolean)
        .join(' · ');
      lines.push(
        `- **${safeText(e.name)}**${e.disambiguation ? ` (${safeText(e.disambiguation)})` : ''}${meta ? ` — ${meta}` : ''} — ${e.mbid}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * @fileoverview musicbrainz_browse_entities — paginate the COMPLETE set of
 * entities linked to a parent MBID: every release on a label, every release-group
 * by an artist, every recording of a work or release, every release in a group.
 * Enumerates entities rather than ordered tracks or performance relationship details.
 * @module mcp-server/tools/definitions/browse-entities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { normalizeMbid } from '@/services/musicbrainz/mbid.js';
import {
  getMusicBrainzService,
  MusicBrainzService,
} from '@/services/musicbrainz/musicbrainz-service.js';
import type {
  BrowseLink,
  EntityType,
  RawArtist,
  RawLabel,
  RawRecording,
  RawRelease,
  RawReleaseGroup,
  RawWork,
} from '@/services/musicbrainz/types.js';
import { applyPageLimit, PageLimit, pageNotice } from './_pagination.js';
import {
  artistCreditString,
  classifyMbidError,
  formatDuration,
  MbidInput,
  normalizeArtistCredits,
  safeText,
} from './_shared.js';

const TARGET_TYPES = ['artist', 'release-group', 'release', 'recording', 'work', 'label'] as const;

const PARENTS: Record<EntityType, readonly BrowseLink[]> = {
  artist: ['area', 'recording', 'release', 'release-group', 'work'],
  label: ['area', 'release'],
  'release-group': ['artist', 'release'],
  release: ['area', 'artist', 'label', 'recording', 'release-group', 'track_artist'],
  recording: ['artist', 'release', 'work'],
  work: ['artist'],
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
    secondaryTypes: z
      .array(z.string())
      .optional()
      .describe(
        'Release-group secondary classifications in upstream order. Omitted when empty; absence does not establish a studio album.',
      ),
    firstReleaseDate: z
      .string()
      .optional()
      .describe('Recording first-release date, possibly partial. Omitted when absent.'),
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
      ...(e['first-release-date'] ? { firstReleaseDate: e['first-release-date'] } : {}),
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
    ...(isReleaseGroup && (e as RawReleaseGroup)['secondary-types']?.length
      ? { secondaryTypes: (e as RawReleaseGroup)['secondary-types'] }
      : {}),
    ...(status ? { status } : {}),
    artistCredit: artistCreditString(normalizeArtistCredits(e['artist-credit'])),
    ...(date ? { date } : {}),
    ...((e as RawRelease).country ? { country: (e as RawRelease).country as string } : {}),
  };
}

export const browseEntitiesTool = tool('musicbrainz_browse_entities', {
  title: 'musicbrainz-mcp-server: browse entities',
  description:
    'Paginate entities linked to one parent MBID. Accepted parents by target: artist → area, recording, release, release-group, work; label → area, release; release-group → artist, release; release → area, artist, label, recording, release-group, track_artist; recording → artist, release, work; work → artist. track_artist enumerates releases crediting an artist on tracks but not at release level. Artist release-groups and release-group editions embed one upstream page in get_* lookups; use this tool for the complete entity set. Recording browse returns identities, not performance attributes/dates or ordered release tracks: use musicbrainz_get_recording for work relationships and musicbrainz_get_release for tracks. Provide exactly one valid parent link. offset pages to any depth; totalCount is the exact filtered upstream entity total. Optional type/status filters apply only on supported parent pairs; preserve applied filters on continuation. Release rows carry status, other entity subtypes use type; release-groups include secondaryTypes and recordings include firstReleaseDate when available.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A nonempty type/status filter has an unknown token, an empty pipe-list member, or is unsupported for the target and parent.',
      recovery:
        'Use type only for release-group by artist or release by artist/label/recording/track_artist; use status only for release by artist/label/recording/release-group/track_artist. Separate valid tokens with | and omit unsupported filters. Types: album, single, ep, broadcast, other, audio drama, audiobook, compilation, demo, dj-mix, field recording, interview, live, mixtape/street, remix, soundtrack, spokenword. Statuses: official, promotion, bootleg, pseudo-release, withdrawn, cancelled.',
    },
    {
      reason: 'invalid_link',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A parent key is unknown, aliases collide, not exactly one nonempty parent is supplied, or the MBID/parent combination is invalid.',
      recovery:
        'Provide exactly one parent key with a nonzero hexadecimal UUID MBID. Accepted parents by target: artist → area, recording, release, release-group, work; label → area, release; release-group → artist, release; release → area, artist, label, recording, release-group, track_artist; recording → artist, release, work; work → artist. releaseGroup and release_group alias release-group; never combine aliases. track_artist uses an artist MBID; verify it with musicbrainz_get_artist.',
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The link MBID is well-formed but no such parent entity exists (HTTP 404).',
      recovery:
        'No parent entity exists with that MBID. For area links, obtain areaId from musicbrainz_get_artist or musicbrainz_get_label for a known artist or label; these tools do not resolve arbitrary areas. For track_artist links, verify the artist with musicbrainz_get_artist or musicbrainz_search_entities. For other parents, verify the ID with the matching musicbrainz_get_* tool or musicbrainz_search_entities.',
    },
  ],

  input: z.object({
    target_type: z.enum(TARGET_TYPES).describe('The entity type to enumerate (the children).'),
    link: z
      .object({
        artist: MbidInput.optional().describe(
          'Parent artist MBID (e.g. release-groups/recordings/releases by this artist).',
        ),
        track_artist: MbidInput.optional().describe(
          'Artist MBID for release-only browse: releases crediting the artist on tracks but not at release level.',
        ),
        label: MbidInput.optional().describe('Parent label MBID (releases on this label).'),
        'release-group': MbidInput.optional().describe(
          'Parent release-group MBID (releases in this group).',
        ),
        release: MbidInput.optional().describe(
          'Parent release MBID (artists, labels, release-groups, or recording entities in this edition; recordings are not ordered tracks).',
        ),
        releaseGroup: MbidInput.optional().describe(
          'Alias for release-group; use only one spelling.',
        ),
        release_group: MbidInput.optional().describe(
          'Alias for release-group; use only one spelling.',
        ),
        recording: MbidInput.optional().describe(
          'Parent recording MBID (artists or releases linked to this recording).',
        ),
        work: MbidInput.optional().describe(
          'Parent work MBID (artists or recordings linked to this work).',
        ),
        area: MbidInput.optional().describe(
          'Parent area MBID (artists, labels, or releases in this area).',
        ),
      })
      .catchall(z.unknown())
      .describe(
        'Exactly one parent MBID. The valid key depends on target_type (see the description).',
      ),
    type: z
      .string()
      .optional()
      .describe(
        'Pipe-separated release types: album, single, ep, broadcast, other, audio drama, audiobook, compilation, demo, dj-mix, field recording, interview, live, mixtape/street, remix, soundtrack, spokenword. Supported for release-group by artist and release by artist/label/recording/track_artist. Primary types union; primary and secondary categories intersect; release-group by artist requires all secondary types. Tokens are trimmed/lowercased; blank means absent.',
      ),
    status: z
      .string()
      .optional()
      .describe(
        'Pipe-separated statuses for release by artist/label/recording/release-group/track_artist: official, promotion, bootleg, pseudo-release, withdrawn, cancelled. Tokens are trimmed/lowercased and unioned; blank means absent.',
      ),
    limit: PageLimit,
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
        'The parent link type used (artist, track_artist, label, release-group, release, recording, work, or area).',
      ),
    linkMbid: z.string().describe('The parent MBID that was browsed.'),
    entities: z.array(EntityRefSchema).describe('This page of linked entities, in upstream order.'),
    offset: z.number().describe('The offset used for this page.'),
    type: z
      .string()
      .optional()
      .describe('Canonical applied pipe-separated type filter; preserve on continuation.'),
    status: z
      .string()
      .optional()
      .describe('Canonical applied pipe-separated status filter; preserve on continuation.'),
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
      'track_artist',
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
    if (!PARENTS[input.target_type].includes(linkType)) {
      throw ctx.fail(
        'invalid_link',
        `Unsupported browse pair: ${input.target_type} by ${linkType}. Accepted parents for ${input.target_type}: ${PARENTS[input.target_type].join(', ')}.`,
      );
    }
    const filters: { type?: string; status?: string } = {};
    for (const field of ['type', 'status'] as const) {
      const supplied = input[field]?.trim();
      if (!supplied) continue;
      const releaseParents =
        field === 'type'
          ? ['artist', 'label', 'recording', 'track_artist']
          : ['artist', 'label', 'recording', 'release-group', 'track_artist'];
      const supported =
        (input.target_type === 'release' && releaseParents.includes(linkType)) ||
        (field === 'type' && input.target_type === 'release-group' && linkType === 'artist');
      if (!supported) {
        throw ctx.fail(
          'invalid_filter',
          `${field} is not supported for ${input.target_type} by ${linkType}; omit this filter.`,
        );
      }
      const tokens = supplied.split('|').map((token) => token.trim().toLowerCase());
      const vocabulary =
        field === 'type'
          ? [
              'album',
              'single',
              'ep',
              'broadcast',
              'other',
              'audio drama',
              'audiobook',
              'compilation',
              'demo',
              'dj-mix',
              'field recording',
              'interview',
              'live',
              'mixtape/street',
              'remix',
              'soundtrack',
              'spokenword',
            ]
          : ['official', 'promotion', 'bootleg', 'pseudo-release', 'withdrawn', 'cancelled'];
      if (tokens.some((token) => !vocabulary.includes(token))) {
        throw ctx.fail(
          'invalid_filter',
          `Invalid ${field} filter: use nonempty pipe-separated tokens from ${vocabulary.join(', ')}.`,
        );
      }
      filters[field] = tokens.join('|');
    }
    let linkMbid: string;
    try {
      linkMbid = normalizeMbid(suppliedMbid);
    } catch (error: unknown) {
      if (classifyMbidError(error) === 'invalid_mbid') {
        throw ctx.fail(
          'invalid_link',
          'Malformed link MBID: supply a nonzero hyphenated hexadecimal UUID.',
        );
      }
      throw error;
    }

    let envelope: Awaited<ReturnType<typeof service.browse>>;
    const limit = applyPageLimit(input.limit, 'musicbrainz_browse_entities', ctx);
    try {
      envelope = await service.browse(
        input.target_type,
        { link: linkType, linkMbid, limit, offset: input.offset, ...filters },
        ctx,
        { signal: ctx.signal },
      );
    } catch (error: unknown) {
      const reason = classifyMbidError(error);
      if (error instanceof McpError && error.code === JsonRpcErrorCode.ValidationError) {
        throw ctx.fail(
          'invalid_link',
          `MusicBrainz rejected the browse query ${input.target_type} by ${linkType}; verify the parent type and MBID.`,
        );
      }
      if (reason === 'entity_not_found') {
        throw ctx.fail('entity_not_found', `No ${linkType} exists with MBID ${linkMbid}.`);
      }
      throw error;
    }

    const key = MusicBrainzService.pluralKey(input.target_type);
    const rawEntities = (envelope[key] ?? []) as unknown[];
    const entities = rawEntities.map((e) => mapEntity(input.target_type, e));
    const total = envelope[`${input.target_type}-count`];

    ctx.enrich.total(total);
    const remaining = total - (input.offset + entities.length);
    if (remaining > 0) ctx.enrich.truncated({ shown: entities.length, cap: limit });
    const notice = pageNotice(
      total,
      input.offset,
      entities.length,
      input.limit,
      limit,
      `No ${input.target_type} entities are linked to ${linkType} ${linkMbid}.`,
    );
    const filterNotice = Object.entries(filters)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
    if (notice)
      ctx.enrich.notice(
        filterNotice ? `${notice} Preserve applied filters: ${filterNotice}.` : notice,
      );

    return {
      targetType: input.target_type,
      linkType,
      linkMbid,
      entities,
      offset: input.offset,
      ...filters,
    };
  },

  format: (result) => {
    const lines = [
      `## Browse ${result.targetType} by ${result.linkType}`,
      `**Parent:** ${result.linkMbid} | **Offset:** ${result.offset} | **This page:** ${result.entities.length}`,
    ];
    if (result.type) lines.push(`**Type filter:** ${safeText(result.type)}`);
    if (result.status) lines.push(`**Status filter:** ${safeText(result.status)}`);
    for (const e of result.entities) {
      const meta = [
        e.type ? safeText(e.type) : null,
        e.status ? safeText(e.status) : null,
        e.artistCredit ? safeText(e.artistCredit) : null,
        e.date,
        e.country,
        e.length,
        e.secondaryTypes?.map(safeText).join(', '),
        e.firstReleaseDate ? `First release: ${safeText(e.firstReleaseDate)}` : null,
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

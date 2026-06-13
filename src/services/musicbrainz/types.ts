/**
 * @fileoverview Domain types for the MusicBrainz Web Service v2. Raw types model
 * the upstream JSON shapes as they actually arrive — sparse and optional-heavy,
 * since MusicBrainz omits fields entirely (and a field can present differently
 * between search and lookup, e.g. `life-span.ended` is `null` from search but
 * `false` from lookup). Normalization preserves absence as "unknown" rather than
 * fabricating concrete values.
 * @module services/musicbrainz/types
 */

/** The six core entity types addressable by MBID across search, lookup, and browse. */
export type EntityType = 'artist' | 'release-group' | 'release' | 'recording' | 'work' | 'label';

/** Parent link types for the browse endpoint (one parent MBID per browse call). */
export type BrowseLink = 'artist' | 'label' | 'release-group' | 'recording' | 'work' | 'area';

// ─── Shared raw sub-shapes ───────────────────────────────────────────────────

/** A life span / date range — `ended` is tri-state across modes (null | bool). */
export interface RawLifeSpan {
  begin?: string | null;
  end?: string | null;
  ended?: boolean | null;
}

export interface RawAlias {
  locale?: string | null;
  name?: string;
  primary?: boolean | null;
  'sort-name'?: string;
  type?: string | null;
}

/** A genre or folksonomy tag with an upstream vote count. */
export interface RawTag {
  count?: number;
  name?: string;
}

export interface RawArea {
  id?: string;
  'iso-3166-1-codes'?: string[];
  name?: string;
  'sort-name'?: string;
}

/** One credited artist within an artist-credit array; `joinphrase` stitches collaborations. */
export interface RawArtistCredit {
  artist?: {
    id?: string;
    name?: string;
    'sort-name'?: string;
    disambiguation?: string;
  };
  joinphrase?: string;
  name?: string;
}

/**
 * A relationship in a lookup payload's `relations[]`, grouped by `target-type`.
 * The nested target entity is keyed by its type (`artist` | `url` | `work` |
 * `recording` | ...), so we model the common ones explicitly.
 */
export interface RawRelation {
  artist?: { id?: string; name?: string; disambiguation?: string };
  attributes?: string[];
  begin?: string | null;
  direction?: string;
  end?: string | null;
  ended?: boolean | null;
  label?: { id?: string; name?: string };
  recording?: { id?: string; title?: string; disambiguation?: string };
  'target-type'?: string;
  type?: string;
  'type-id'?: string;
  url?: { id?: string; resource?: string };
  work?: { id?: string; title?: string; disambiguation?: string };
}

// ─── Raw entity payloads (lookup / search hits) ──────────────────────────────

export interface RawArtist {
  aliases?: RawAlias[];
  area?: RawArea | null;
  'begin-area'?: RawArea | null;
  country?: string | null;
  disambiguation?: string;
  gender?: string | null;
  genres?: RawTag[];
  id: string;
  'life-span'?: RawLifeSpan;
  name?: string;
  relations?: RawRelation[];
  'release-groups'?: RawReleaseGroup[];
  score?: number;
  'sort-name'?: string;
  tags?: RawTag[];
  type?: string | null;
  'type-id'?: string | null;
}

export interface RawReleaseGroup {
  'artist-credit'?: RawArtistCredit[];
  'cover-art-archive'?: RawCoverArtStub;
  disambiguation?: string;
  'first-release-date'?: string;
  genres?: RawTag[];
  id: string;
  'primary-type'?: string | null;
  'primary-type-id'?: string | null;
  relations?: RawRelation[];
  releases?: RawRelease[];
  score?: number;
  'secondary-types'?: string[];
  tags?: RawTag[];
  title?: string;
}

/** The free `cover-art-archive` stub folded into release / release-group payloads. */
export interface RawCoverArtStub {
  artwork?: boolean;
  back?: boolean;
  count?: number;
  darkened?: boolean;
  front?: boolean;
}

export interface RawTrack {
  id?: string;
  length?: number | null;
  number?: string;
  position?: number;
  recording?: RawRecording;
  title?: string;
}

export interface RawMedium {
  format?: string | null;
  'format-id'?: string | null;
  position?: number;
  title?: string;
  'track-count'?: number;
  'track-offset'?: number;
  tracks?: RawTrack[];
}

export interface RawLabelInfo {
  'catalog-number'?: string | null;
  label?: {
    id?: string;
    name?: string;
    'label-code'?: number | null;
    disambiguation?: string;
  } | null;
}

export interface RawRelease {
  'artist-credit'?: RawArtistCredit[];
  barcode?: string | null;
  country?: string | null;
  'cover-art-archive'?: RawCoverArtStub;
  date?: string;
  disambiguation?: string;
  id: string;
  'label-info'?: RawLabelInfo[];
  media?: RawMedium[];
  packaging?: string | null;
  'packaging-id'?: string | null;
  relations?: RawRelation[];
  'release-group'?: RawReleaseGroup;
  score?: number;
  status?: string | null;
  'status-id'?: string | null;
  'text-representation'?: { language?: string | null; script?: string | null };
  title?: string;
}

export interface RawRecording {
  'artist-credit'?: RawArtistCredit[];
  disambiguation?: string;
  'first-release-date'?: string;
  id: string;
  isrcs?: string[];
  length?: number | null;
  relations?: RawRelation[];
  releases?: RawRelease[];
  score?: number;
  title?: string;
  video?: boolean | null;
}

export interface RawWork {
  aliases?: RawAlias[];
  attributes?: { type?: string; value?: string; 'type-id'?: string }[];
  disambiguation?: string;
  genres?: RawTag[];
  id: string;
  iswcs?: string[];
  language?: string | null;
  languages?: string[];
  relations?: RawRelation[];
  score?: number;
  tags?: RawTag[];
  title?: string;
  type?: string | null;
  'type-id'?: string | null;
}

export interface RawLabel {
  aliases?: RawAlias[];
  area?: RawArea | null;
  country?: string | null;
  disambiguation?: string;
  genres?: RawTag[];
  id: string;
  'label-code'?: number | null;
  'life-span'?: RawLifeSpan;
  name?: string;
  relations?: RawRelation[];
  score?: number;
  'sort-name'?: string;
  tags?: RawTag[];
  type?: string | null;
  'type-id'?: string | null;
}

// ─── Envelopes ───────────────────────────────────────────────────────────────

/**
 * Search response envelope. The entity array is keyed by the pluralized type
 * (`artists`, `release-groups`, `releases`, `recordings`, `works`, `labels`).
 * `count` is total matches; per-result `score` is 0–100 Lucene relevance.
 */
export interface SearchEnvelope {
  artists?: RawArtist[];
  count?: number;
  created?: string;
  labels?: RawLabel[];
  offset?: number;
  recordings?: RawRecording[];
  'release-groups'?: RawReleaseGroup[];
  releases?: RawRelease[];
  works?: RawWork[];
}

/**
 * Browse response envelope — distinct from search: the total lives under
 * `{type}-count` (e.g. `release-count`), not `count`. `offset` pages arbitrarily
 * deep. Identifier endpoints (`/iswc`) share this browse-style shape.
 */
export interface BrowseEnvelope {
  'artist-count'?: number;
  'artist-offset'?: number;
  artists?: RawArtist[];
  'label-count'?: number;
  'label-offset'?: number;
  labels?: RawLabel[];
  'recording-count'?: number;
  'recording-offset'?: number;
  recordings?: RawRecording[];
  'release-count'?: number;
  'release-group-count'?: number;
  'release-group-offset'?: number;
  'release-groups'?: RawReleaseGroup[];
  'release-offset'?: number;
  releases?: RawRelease[];
  'work-count'?: number;
  'work-offset'?: number;
  works?: RawWork[];
}

/** ISRC endpoint response: `{ isrc, recordings[] }` (one ISRC → many recordings). */
export interface IsrcEnvelope {
  isrc?: string;
  recordings?: RawRecording[];
}

/** Cover Art Archive response shape (identical before and after the release-group 307 redirect). */
export interface RawCoverArtResponse {
  images?: RawCoverArtImage[];
  release?: string;
}

export interface RawCoverArtImage {
  approved?: boolean;
  back?: boolean;
  comment?: string;
  edit?: number;
  front?: boolean;
  id?: string | number;
  image?: string;
  thumbnails?: {
    '250'?: string;
    '500'?: string;
    '1200'?: string;
    small?: string;
    large?: string;
  };
  types?: string[];
}

/** Options threaded through service calls for cancellation. */
export interface CallOptions {
  signal?: AbortSignal;
}

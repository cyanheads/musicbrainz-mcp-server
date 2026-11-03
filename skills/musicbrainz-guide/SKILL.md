---
name: musicbrainz-guide
description: Resolve music identities and follow musicbrainz_* tools across discographies, editions, tracklists, recordings, compositions, credits, and artwork. Use for multi-step music metadata research, ISRC/ISWC/barcode resolution, or MusicBrainz Lucene queries.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use MusicBrainz for music identities, discographies, edition metadata, credits, relationships, and Cover Art Archive image links. Access is keyless and read-only. Audio playback, audio fingerprint recognition, catalog editing, and licensing clearance are outside this server's surface.

## Identifiers

Choose the entity before resolving its name:

| Entity | Represents | Where its MBID comes from |
|:---|:---|:---|
| Artist | A person, group, or other credited artist | Artist search, artist credits, relationship targets |
| Release-group | An album/single across its editions | Release-group search, artist discography, release's parent group |
| Release | A specific edition | Release search, group's editions, recording's appearances, barcode lookup |
| Recording | Recorded audio that can appear on multiple releases | Recording search, release track's recording link, ISRC lookup, work relationships |
| Work | A composition, including movements or arrangements | Work search, recording's work relationships, ISWC lookup |
| Label | A music label | Label search, release label information, relationship targets |

`musicbrainz_lookup_identifier` resolves ISRCs to recordings, ISWCs to works, and barcodes to releases. Keep each returned MBID's entity type attached to it; identical UUID syntax does not make types interchangeable. Preserve identifiers as strings, including leading zeros.

Area MBIDs come from an artist or label's returned `areaId`; names and country codes are not area MBIDs. IPI/ISNI identify people or organizations, while a work's society attributes identify that composition in a society's catalog.

## Gates

1. Confirm the intended identity before traversing: compare credited artist, disambiguation, dates, and edition evidence. A high search score or standard identifier can still yield several candidates; do not silently choose the first.
2. Before saying “all” or “none,” establish coverage with the appropriate browse and continuation notices. Embedded discographies, editions, release appearances, and work recording relationships can be partial. A failed call or an unrequested relationship is not evidence of absence.
3. Select a release edition before attributing its date, label, barcode, track order, or artwork to the user's copy. A release-group's first-release date and representative artwork describe the group, not every edition.
4. Preserve relationship direction and attributes when reporting credits, movements, and arrangements. Browse supplies entity identities; obtain recording relationship details before making performance-specific claims.
5. Report missing catalog facts as missing. Community metadata and external links do not establish current copyright ownership or permission to reuse an image or recording.

## Core chain

Resolve a name with `musicbrainz_search_entities`, or a supplied standard identifier with `musicbrainz_lookup_identifier`. Check the candidates, then call the matching `musicbrainz_get_*` tool. Follow returned MBIDs and typed relationships for the next hop; use `musicbrainz_browse_entities` when the task needs the linked set rather than a detail preview.

## Workflows

### Discography and editions

For an artist's albums, resolve the artist, browse release-groups, and inspect primary and secondary types. “Album” alone does not establish a studio album: live albums and compilations can share that primary type. Missing secondary types mean unclassified metadata, so qualify uncertain classifications. Keep the applied filters when continuing; pipe-separated type filters do not universally mean “either,” so follow the tool's category semantics.

For a particular pressing, browse the group's releases, narrow candidates by country and date, then use `musicbrainz_get_release` to compare format, barcode, and catalog number with the user's evidence. Retrieve remaining media before reporting a complete tracklist. Recording enumeration cannot reconstruct ordered track occurrences, including repeated appearances of the same recording.

### Track credits and compositions

For a named track on an edition, start from `musicbrainz_get_release` and use the track's own artist credit. A release credit such as “Various Artists” does not identify the performer of each track. Follow its recording MBID to `musicbrainz_get_recording` for performance relationships, then the work relationship to `musicbrainz_get_work` for writers/composers, ISWCs, movements, or arrangements. A recording credit does not replace a missing edition-specific track credit, and the work's writer is not automatically its performer.

For performances of a composition, resolve the work, browse its recordings, and retrieve recording details where the question needs performance dates or relationship attributes. For classical parts, follow work targets and retain ordering keys and direction; do not sort movements by title or treat an arrangement as the same work without checking the relationship.

For society registrations, inspect work attributes, then follow the writer/composer's artist MBID for IPI/ISNI. Preserve repeated society entries and their string values. These are catalog identifiers, not a determination of current ownership or licensing authority.

For labels or artists in an area, obtain `areaId` from a known artist or label and browse by that returned MBID. Check whether the associated area matches the user's requested geography; a birth area or country name is not a substitute for the requested area.

### Artwork and external identities

Use `musicbrainz_get_cover_art` for the selected release's image URLs. Use group artwork only when representative artwork satisfies the task. Inspect full-archive availability and notices before treating an empty image page as no artwork.

Follow returned external links for cross-database identities. Keep the originating entity attached: an album group and one edition can link to different external records. Do not manufacture a Discogs identifier or Wikidata QID from a title match.

## References

- [Lucene query syntax and entity-specific examples](references/query-syntax.md)

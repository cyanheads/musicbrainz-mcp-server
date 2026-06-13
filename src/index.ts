#!/usr/bin/env node
/**
 * @fileoverview musicbrainz-mcp-server entry point. Wraps the live MusicBrainz
 * Web Service v2 and the Cover Art Archive: search / lookup / browse music
 * metadata, traverse relationships, resolve standard identifiers, and fetch
 * cover art. Keyless, read-only, CC0 core data.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initCoverArtService } from './services/cover-art/cover-art-service.js';
import { initMusicBrainzService } from './services/musicbrainz/musicbrainz-service.js';

await createApp({
  name: 'musicbrainz-mcp-server',
  title: 'musicbrainz-mcp-server',
  websiteUrl: 'https://github.com/cyanheads/musicbrainz-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: [],
  instructions:
    "Open music metadata over the live MusicBrainz Web Service v2 and the Cover Art Archive. Entities are addressed by MBID (a UUID); starting from a name, call musicbrainz_search_entities first and chain the MBID into the matching musicbrainz_get_* tool. The get_* tools embed at most one page (25) of any linked list (a discography, a label's releases, a work's recordings) — use musicbrainz_browse_entities for the complete set. musicbrainz_lookup_identifier resolves an ISRC/ISWC/barcode without a name search. The server is rate-limited to ~1 request/second against MusicBrainz, so batch enumeration via browse paces accordingly. External IDs (Wikidata QID, Discogs) arrive as url-rels chainable to those servers.",
  setup(core) {
    initMusicBrainzService(core.config.mcpServerVersion);
    initCoverArtService();
  },
});

# musicbrainz-mcp-server — Design

Open music metadata over the live MusicBrainz Web Service v2 and the Cover Art Archive. Keyless, read-only, CC0 core data. Search artists / release-groups / releases / recordings / works / labels, pull discographies and tracklists, traverse relationships (band membership, performers, producers, writers), resolve standard identifiers (ISRC, barcode, ISWC), and fetch cover art.

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `musicbrainz_search_entities` | Full-text search across an entity type (artist, release-group, release, recording, work, label) using a query string. Returns ranked matches with MBID, name/title, disambiguation, type, and a 0–100 relevance score. The required first step when starting from a name, not an MBID. | `entity_type` (enum), `query` (string), `limit` (1–100, default 25), `offset` (default 0) | `readOnlyHint`, `openWorldHint` |
| `musicbrainz_get_artist` | Artist profile by MBID: type, country, life span, gender, aliases, tags/genres, plus discography (release-groups) and band-membership / collaboration relationships and external links (Wikidata, Discogs, official site). The 80% artist detail call. Discography and relationships are capped at one page — use `musicbrainz_browse_entities` for a prolific artist's full output. | `mbid` (UUID), `inc_release_groups` (bool, default true), `inc_relationships` (bool, default true) | `readOnlyHint`, `openWorldHint` |
| `musicbrainz_get_release_group` | Release-group ("the album" above specific pressings) by MBID: primary + secondary type, first-release date, artist credit, the list of releases (editions), tags/genres, and whether cover art exists. Use `musicbrainz_get_release` for a specific edition's tracklist. | `mbid` (UUID) | `readOnlyHint`, `openWorldHint` |
| `musicbrainz_get_release` | One edition's full detail by MBID: tracklist (media → tracks → recordings with lengths and MBIDs), label + catalog number, barcode, country, release date, format, packaging, text representation, and a cover-art availability stub. | `mbid` (UUID) | `readOnlyHint`, `openWorldHint` |
| `musicbrainz_get_recording` | Recording (a specific performance/track) by MBID: length, artist credits, ISRCs, the releases it appears on, the work(s) it performs, and performance/production relationships (who played, produced, engineered, conducted — with role and credited artist MBID). | `mbid` (UUID), `inc_relationships` (bool, default true) | `readOnlyHint`, `openWorldHint` |
| `musicbrainz_get_work` | Work (a composition — the song as written, distinct from any recording) by MBID: type, language(s), ISWCs, writer/composer/lyricist relationships, and the recordings that perform it. Recording relations are capped at one page — use `musicbrainz_browse_entities` (`recording` by `work`) for the complete list. | `mbid` (UUID), `inc_relationships` (bool, default true) | `readOnlyHint`, `openWorldHint` |
| `musicbrainz_get_label` | Label by MBID: type, country, life span, label code, area, aliases, tags, and external links. Its releases are a potentially huge linked set — fetch them via `musicbrainz_browse_entities` (`release` by `label`), not here. | `mbid` (UUID) | `readOnlyHint`, `openWorldHint` |
| `musicbrainz_lookup_identifier` | Resolve a standard identifier to MusicBrainz entities without a name search — the deterministic path when you already hold an ID. ISRC → recordings, ISWC → works, barcode → releases. | `id_type` (enum: isrc, iswc, barcode), `value` (string) | `readOnlyHint`, `openWorldHint` |
| `musicbrainz_get_cover_art` | Cover Art Archive images for a release or release-group MBID: front/back flags, image types, full-resolution URLs, and 250/500/1200px thumbnails. Returns an empty image set (not an error) when the entity has no art. Separate from `musicbrainz_get_release` so art is fetchable without the full record. | `mbid` (UUID), `entity_type` (enum: release, release-group; default release) | `readOnlyHint`, `openWorldHint` |
| `musicbrainz_browse_entities` | Paginate the complete set of entities linked to a parent MBID — every release on a label, every release-group by an artist, every recording of a work, every release in a release-group. The only complete-enumeration path; the `get_*` tools' embedded lists are capped at one page. | `target_type` (enum), `link` (object: one of artist/label/release-group/work/recording/area MBID), `limit` (1–100, default 25), `offset` (default 0) | `readOnlyHint`, `openWorldHint` |

**Total: 10 tools.** All read-only — no write, update, or destructive operations exist in this surface (MusicBrainz mutation requires an authenticated editor account and is out of scope).

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `musicbrainz://{entity_type}/{mbid}` | A single MusicBrainz entity by type and MBID, returned as a stable injectable-context resource. Mirrors the corresponding `get_*` tool with default `inc` sets. `entity_type` ∈ artist, release-group, release, recording, work, label. | None (single entity) |

One resource template, not six — the entity type is a path parameter. This is a convenience mirror for clients that support resources; every entity is fully reachable through the `get_*` tools, so tool-only clients lose nothing. No `list()` — the corpus is millions of entities; discovery is via `search_entities`, not resource enumeration.

### Prompts

None. This is a data/lookup server; there is no recurring multi-step interaction worth templating. (The "now playing → full context" workflow in Design Decisions is a candidate *tool*, not a prompt — deferred.)

## Overview

`musicbrainz-mcp-server` is a single-source, multi-endpoint wrapper over the **MusicBrainz Web Service v2** (`https://musicbrainz.org/ws/2`, JSON via `?fmt=json`), plus the related **Cover Art Archive** (`https://coverartarchive.org`) for album artwork. MusicBrainz is the open, community-maintained music encyclopedia; its core entity data is **CC0** (public-domain dedication — no attribution, no anti-AI/anti-redistribution clause), and the **MBID** (a UUID per entity) is the de-facto cross-service identifier for music.

It is the music leg of the culture cluster (alongside `openlibrary`, `gutenberg`, and planned film/TV/games servers) and composes with `wikidata-mcp-server` (MBID ↔ Wikidata QID, surfaced via URL relationships) and `wikipedia-mcp-server` (artist/album bios).

**Audience:** music tooling and discovery agents, catalogers and metadata engineers, "what album is this / who played on it" assistants, and anything resolving a track / artist / release to stable IDs and linked facts.

**Access model — three request types, no overlap.** Every tool maps to exactly one of MusicBrainz's three access modes:

| Mode | Endpoint shape | Tool(s) | When |
|:-----|:---------------|:--------|:-----|
| **Search** | `/ws/2/{type}?query=…` (Lucene) | `search_entities` | You have *text*, not an MBID. Returns ranked MBIDs + score. |
| **Lookup** | `/ws/2/{type}/{mbid}?inc=…` | `get_artist`, `get_release_group`, `get_release`, `get_recording`, `get_work`, `get_label`, `lookup_identifier` | You have an MBID (or an ISRC/ISWC/barcode). `inc=` folds linked data into one call. |
| **Browse** | `/ws/2/{type}?{link}={mbid}&limit=…&offset=…` | `browse_entities` | You need the *complete* linked set, beyond the one capped page that lookup `inc` returns. |

## Requirements

- **Keyless.** No API key, no account, no OAuth. Auth mode is `none`.
- **Mandatory descriptive `User-Agent`.** MusicBrainz blocks requests without an application + contact User-Agent (e.g. `musicbrainz-mcp-server/<version> (<contact>)`). This is a hard requirement, configured once in the service layer; the contact is configurable via env var.
- **~1 request/second average rate limit (the real constraint).** Enforced per IP across the whole hosted instance. Exceeding it returns **HTTP 503 + `Retry-After`**. A client-side global rate limiter + response caching is mandatory for the hosted endpoint, or concurrent users starve each other. (See Design Decisions — this single fact gates hosting viability; `courtlistener-mcp-server` at 5 req/min is the precedent for hosting a rate-limited source.)
- **Read-only.** Search, lookup, browse, and image fetch only. No mutation (editing MusicBrainz requires an authenticated editor account — explicitly out of scope).
- **MBID-keyed.** Entities are addressed by UUID; names resolve to MBIDs via search first. Every result returns its MBID for chaining.
- **`inc` is the efficiency lever.** One artist lookup with `inc=release-groups+artist-rels+url-rels+tags+genres` returns discography, band members, external links, and genres in a single request. Service methods are built around `inc`, not serial browses, to stay under the rate limit.
- **Licensing discipline.** Surface CC0 **core entity data** only. Some supplementary text (annotations) is CC BY-NC-SA — do not fetch or surface it as if it were CC0. Cover Art Archive serves image *files* whose copyright stays with the rights holders; the server links/proxies thumbnail and image URLs, it does not rehost or relicense them.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `musicbrainz-service` | MusicBrainz WS/2 (`musicbrainz.org/ws/2`) — search, lookup (`inc`), browse, identifier endpoints. Owns the User-Agent, the ~1 req/sec global rate limiter, response caching, and `withRetry` backoff. | `search_entities`, all six `get_*` tools, `lookup_identifier`, `browse_entities` |
| `cover-art-service` | Cover Art Archive (`coverartarchive.org`) — release / release-group image metadata + thumbnail/full URLs. Treats 404 as "no art" (empty set), not an error. | `get_cover_art` (and the cover-art availability stub echoed by `get_release` / `get_release_group` comes free from the WS/2 payload, no CAA call needed) |

**Resilience (both services).** Retry boundary wraps the full fetch + parse pipeline via `withRetry` from `/utils`. Backoff base ~1–2s (rate-limited tier). `fetchWithTimeout` maps non-OK → `ServiceUnavailable`; `httpErrorFromResponse` captures the 503 `Retry-After`. Parse-failure classification: an HTML error page (MusicBrainz occasionally serves one under load) is a transient `ServiceUnavailable`, not a `SerializationError`.

**Rate-limit + cache (MusicBrainz service).** A single process-wide token-bucket limiter (~1 req/sec, configurable) serializes all upstream calls; on a hosted multi-tenant instance every tenant shares it. MBIDs are stable and entity data changes slowly, so lookup/browse responses are cached (TTL configurable) to keep most calls off the wire entirely. Cache key includes the `inc` set. Implemented with `ctx.state` (tenant-shared cache is acceptable here — the data is public CC0, no tenant isolation concern).

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `MUSICBRAINZ_CONTACT` | Yes | Contact string (email or URL) embedded in the mandatory `User-Agent`. MusicBrainz blocks requests without it. |
| `MUSICBRAINZ_BASE_URL` | No | Override the WS/2 base (default `https://musicbrainz.org/ws/2`). For pointing at a private mirror / `beta.musicbrainz.org`. |
| `MUSICBRAINZ_RATE_LIMIT_RPS` | No | Client-side request-per-second ceiling (default `1`). Lower for shared hosting headroom. |
| `MUSICBRAINZ_CACHE_TTL` | No | Response cache TTL in seconds (default e.g. `86400` — data changes slowly). `0` disables caching. |
| `COVER_ART_BASE_URL` | No | Override the Cover Art Archive base (default `https://coverartarchive.org`). |

`User-Agent` is assembled from the package name + version (already in `package.json`) + `MUSICBRAINZ_CONTACT`. The version is not a separate env var — it derives from the build. Goes in `src/config/server-config.ts` as its own Zod schema (`parseEnvConfig`), never merged with core config.

## Implementation Order

1. **Config + server setup** — `server-config.ts` (contact, base URLs, rate limit, cache TTL); wire `setup()` to init both services; set `createApp` `name`/`title` to `musicbrainz-mcp-server`, `websiteUrl`, server-level `instructions` (search-before-lookup, rate-limit note).
2. **`musicbrainz-service`** — fetch wrapper with User-Agent, global rate limiter, cache, `withRetry`; methods: `search(type, query, {limit, offset})`, `lookup(type, mbid, {inc})`, `browse(target, link, {limit, offset})`, `resolveIdentifier(idType, value)`. Domain types per entity.
3. **`cover-art-service`** — `getImages(entityType, mbid)`; 404 → empty set.
4. **Read-only tools (all 10 are read-only):** `search_entities` → `get_artist`, `get_release_group`, `get_release`, `get_recording`, `get_work`, `get_label` → `lookup_identifier` → `browse_entities` → `get_cover_art`.
5. **Resource** — `musicbrainz://{entity_type}/{mbid}` mirroring the `get_*` lookups.
6. **Prompts** — none.

Each step is independently testable. There are no write tools.

## Domain Mapping

Six core nouns, each with the three access modes. The matrix below is what each tool composes; "browse links" are the parent→child relationships `browse_entities` paginates.

| Noun | Search | Lookup (key `inc`) | Browse links (this noun by parent) |
|:-----|:-------|:-------------------|:-----------------------------------|
| **artist** | ✔ `score`, type, country, life-span, area, tags | `release-groups`, `artist-rels`, `url-rels`, `aliases`, `tags`, `genres` | by `area` |
| **release-group** | ✔ primary/secondary type, first-release-date | `releases`, `artist-credits`, `tags`, `genres` | by `artist` |
| **release** | ✔ barcode, status, date, country, label | `recordings`, `media`, `labels`, `artist-credits`, `release-groups`, `isrcs` | by `artist`, `label`, `release-group`, `recording` |
| **recording** | ✔ length, ISRCs, artist-credit | `artist-credits`, `releases`, `isrcs`, `artist-rels`, `work-rels`, `url-rels` | by `artist`, `release`, `work` |
| **work** | ✔ ISWCs, type, language | `artist-rels`, `recording-rels`, `aliases`, `tags`, `url-rels` | by `artist` |
| **label** | ✔ type, country, code, area | `aliases`, `tags`, `url-rels` | by `area` |

**Identifier endpoints (deterministic, no name search):**

| Identifier | Path | Returns | Tool routing |
|:-----------|:-----|:--------|:-------------|
| ISRC | `/ws/2/isrc/{isrc}` (dedicated endpoint) | `{ isrc, recordings[] }` (one-to-many) | `lookup_identifier` `id_type=isrc` |
| ISWC | `/ws/2/iswc/{iswc}` (dedicated endpoint) | `{ … works[] }` | `lookup_identifier` `id_type=iswc` |
| barcode | `/ws/2/release?query=barcode:{value}` (search filter, **not** an endpoint) | ranked `releases[]` (exact = score 100) | `lookup_identifier` `id_type=barcode` |

## Workflow Analysis

Most tools are single-call. Two warrant call-flow documentation: `lookup_identifier` (mode-dispatched routing) and the deferred "full context" moonshot.

**`lookup_identifier` (1 upstream call, routed by `id_type`):**

| # | `id_type` | Upstream call | Output shape |
|:--|:----------|:--------------|:-------------|
| 1 | `isrc` | `GET /ws/2/isrc/{value}?fmt=json` | recordings carrying that ISRC (often >1) — recordings are included by default; `inc=` is **not** supported on this endpoint (returns 400) |
| 1 | `iswc` | `GET /ws/2/iswc/{value}?fmt=json` | works carrying that ISWC — works are included by default; `inc=` is **not** supported on this endpoint (returns 400) |
| 1 | `barcode` | `GET /ws/2/release?query=barcode:{value}&fmt=json` | ranked releases with that barcode |

The split matters: ISRC/ISWC are true endpoints (exact, deterministic), barcode is a Lucene search filter (ranked, may return near-matches). The handler routes by `id_type`; the output schema is a discriminated union on which entity type came back (recordings | works | releases), so the agent knows what it's holding.

**Deferred moonshot — `musicbrainz_get_now_playing_context` (5–7 calls, fan-out).** Take an artist+track or an ISRC and return the recording, its primary release with cover art, the artist profile, key collaborators, and Wikidata/Wikipedia cross-links in one call. Not in v1 — it's a thick workflow tool that composes the v1 surface, best added once the single-entity tools are proven. Documented here so the v1 service methods (especially `resolveIdentifier` and the url-rels extraction) are shaped to support it later. When built: `Promise.allSettled` fan-out (recording lookup ∥ artist lookup ∥ CAA fetch), so one failing leg degrades to a warning rather than tanking the call.

## Design Decisions

- **Six separate `get_*` lookup tools, not one mode-dispatched `get_entity`.** The brief's instinct, confirmed by live probing: each entity's payload shape genuinely diverges — artist → discography + band membership; release → media/tracklist + label-info + barcode; recording → performers + ISRCs + work-rels; work → writers + ISWCs + recording-rels. A single `get_entity(type, mbid)` would carry a sprawling six-arm output union that's harder for the agent to reason about than six focused tools with tight, purpose-built schemas. Mode consolidation is for related ops on *one* noun; these are six different nouns. The cost is six tool slots, paid for by clarity at the point of selection and at the point of reading output.

- **`get_work` added to the brief's 9-tool sketch → 10 tools.** The brief lists `work` as a first-class searchable entity but sketched no work-detail tool. That strands work MBIDs: `search_entities entity_type=work` (857 hits for "Bohemian Rhapsody") and the `work-rels` on recordings both yield work MBIDs an agent could then only re-search, never detail — the classic dangling-ID gap. `get_work` closes it and rounds out the relationship graph (composition ↔ writers ↔ recordings), surfacing ISWC as the work-level standard identifier. Probed shape confirms it's worth a tool: type, language(s), ISWCs, writer relations, and 158 recording-rels for one song.

- **`browse_entities` is a correctness tool, not a convenience.** Lookup `inc` returns exactly one page — **25 by default, 100 max, no deep offset.** Probing confirmed: Radiohead's `inc=release-groups` returned exactly 25; EMI as a label has **23,011** releases. Without browse, the server would silently return truncated linked sets and present them as complete — a correctness gap. Browse's real competitor is lookup+`inc` (not search), and it wins wherever the linked set exceeds one page. Every `get_*` tool whose embedded list can truncate (artist discography, work recordings, label releases) names `browse_entities` as the complete-enumeration path in its description, and discloses truncation in output (`truncated`, total count from the WS/2 `*-count` field).

- **`lookup_identifier` consolidates three identifier types under one tool, routing by `id_type`.** ISRC and ISWC hit dedicated endpoints; barcode is a search filter. They share a goal ("I hold a standard ID, give me the entity") so they're one tool with an enum, not three — but the output is a discriminated union (recordings | works | releases) because the entity type differs by identifier. Kept distinct from `search_entities` because these are *deterministic resolvers*, not ranked text search — different cost, different certainty, different agent intent.

- **Cover art is a separate service and a separate tool.** CAA is a different host (`coverartarchive.org`) with its own response shape and its own failure mode: a release legitimately having no art. Probing confirmed CAA returns **HTTP 404 when no art exists** — so `get_cover_art` treats 404 as a clean empty image set, never an error. Keeping it separate from `get_release` means art is fetchable without pulling the full record, and the absence of art doesn't surface as a record-fetch failure. The WS/2 release payload *also* carries a free `cover-art-archive: { front, back, count, artwork }` stub (confirmed in probing), so `get_release` can report *whether* art exists without a CAA round-trip; the actual image URLs require `get_cover_art`.

- **MBID + url-rels on every result; the server does not chase external services.** The MBID is the cross-service key (CAA, Wikidata, Discogs, future Discogs/lyrics servers) — returned on every result for chaining. `url-rels` is where external IDs live (Wikidata QID, Discogs, official site, streaming, allmusic — all confirmed present on the Radiohead lookup), so the `get_*` tools surface them. The server does **not** itself call Wikidata/Wikipedia — it hands the agent the QID/URL and lets the agent chain to those servers. (This honors the "don't probe adjacent services" boundary and keeps the rate-limit budget on MusicBrainz alone.)

- **Per-result `score` is surfaced from search, raw.** The search envelope carries a 0–100 Lucene relevance `score` per result (confirmed: exact matches score 100). This is *real* upstream signal (not a fabricated confidence metric), so it's surfaced as-is — it's the agent's signal for "is the top hit actually the thing I searched for, or a weak partial match." Results stay in MusicBrainz's returned (score-descending) order; the server does not re-rank.

- **No DataCanvas, no mirror.** This is a search/detail/resolve surface returning entity records inline — not analytical rows an agent would run SQL over, so DataCanvas earns nothing here (it gates on analytical *shape*, not result size). A local mirror is also wrong: the corpus (~2M artists, ~30M recordings) is too large to bake in, and the data is queried far more narrowly than a mirror's full-sync economics assume. Live API + aggressive caching is the correct data path.

- **`inc` flags exposed as a couple of coarse booleans, not raw `inc` strings.** Tools like `get_artist` take `inc_release_groups` / `inc_relationships` booleans rather than a free-form `inc` parameter. The 80% caller wants "the useful default slice"; exposing raw `inc` tokens leaks MusicBrainz's vocabulary into the tool surface and invites invalid combinations. The handler maps the booleans to the right `inc=` set internally. Power users who need an exotic linked set use `browse_entities`.

- **Naming: `musicbrainz_` prefix.** The canonical brand name — long but unambiguous, on par with `libofcongress_`. Not `music_` (too generic, implies streaming/playback this server doesn't do). Every tool is `musicbrainz_{verb}_{noun}`; `get_*` tools are 2-segment-noun (`get_release_group`) where the noun is inherently two words.

## Error Contracts

Per-tool typed contracts (`errors: [{ reason, code, when, recovery, retryable? }]`). Baseline codes (`ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `InternalError`) bubble freely and are not re-declared. The live API exposes a sharp **400-vs-404 split** that the contracts encode:

| Tool(s) | reason | code | when | retryable |
|:--------|:-------|:-----|:-----|:----------|
| all `get_*`, `get_cover_art` | `invalid_mbid` | `InvalidParams` | MBID is malformed or the all-zeros sentinel — MusicBrainz returns **HTTP 400** `{"error":"Invalid mbid."}` | no |
| all `get_*` | `entity_not_found` | `NotFound` | MBID is well-formed but no such entity exists — MusicBrainz returns **HTTP 404** `{"error":"Not Found"}` | no |
| `get_cover_art` | *(none — empty set)* | — | No art for this entity — CAA returns 404, mapped to an empty image set, **not** an error | — |
| `lookup_identifier` | `identifier_not_found` | `NotFound` | Valid-format ISRC/ISWC/barcode that resolves to zero entities | no |
| `search_entities`, `browse_entities` | *(none — empty list)* | — | Zero matches is a valid empty result with a notice, not an error | — |
| all (upstream) | *(baseline)* | `ServiceUnavailable` | 503 + `Retry-After` (rate-limited) or 5xx / HTML error page under load | yes |

**Recovery messaging examples** (the agent's only signal for its next move):

- `invalid_mbid` → "MBID must be a 36-character UUID (e.g. `a74b1b7f-71a5-4011-9441-d0b5e4122711`). Use `musicbrainz_search_entities` to find an entity's MBID from its name."
- `entity_not_found` → "No `{entity_type}` exists with that MBID. Verify the ID, or search by name with `musicbrainz_search_entities`."
- `identifier_not_found` → "No entity carries `{id_type}` `{value}`. Check the identifier, or try `musicbrainz_search_entities`."
- `ServiceUnavailable` (rate limit) → carries the `Retry-After`; "MusicBrainz is rate-limiting (~1 req/sec). Retry after the indicated delay."

The empty-result cases (`get_cover_art` no-art, search/browse zero-hits) deliberately return success with an `enrichment` notice rather than throwing — an empty set is information, and forcing the agent to catch an error for "no art exists" would be a worse interface.

## Known Limitations

- **~1 req/sec ceiling is the binding constraint on a hosted instance.** Caching mitigates repeat lookups, but cold multi-tenant load is serialized behind one shared limiter. Acceptable (precedent: `courtlistener` at 5 req/min); callers doing bulk enumeration via `browse_entities` will feel the pace.
- **Lookup `inc` lists are capped at one page (25 default / 100 max, no deep offset).** Mitigated by `browse_entities` for complete enumeration and disclosed via truncation fields — but an agent that reads only a `get_artist` discography without checking the truncation flag can mistake a partial list for complete.
- **Sparsity / nullability drift across modes.** The same field can present differently between search and lookup — e.g. `life-span.ended` came back `null` from search but `false` from lookup. Domain schemas must mark cross-entity-shared fields optional/nullable and the normalization layer must not fabricate values from missing upstream data. (Tests must include a sparse-payload case per the framework checklist.)
- **Annotations are CC BY-NC-SA, not CC0.** The server stays on core entity data and does not fetch or surface annotation text — a deliberate scope line, not an oversight.
- **Cover art copyright stays with rights holders.** CAA image/thumbnail URLs are linked/proxied, never rehosted or relicensed; only the MusicBrainz core metadata is CC0.

## API Reference

- **Base:** `https://musicbrainz.org/ws/2` · JSON via `?fmt=json` · keyless · mandatory descriptive `User-Agent`.
- **Search:** `/{type}?query={lucene}&limit={≤100}&offset={n}&fmt=json` → `{ created, count, offset, {type}s: [ { id, score, … } ] }`. `count` is total matches; `score` is 0–100 relevance.
- **Lookup:** `/{type}/{mbid}?inc={a+b+c}&fmt=json` → the entity with requested sub-resources folded in. `inc` tokens vary by type (e.g. `release-groups`, `artist-rels`, `url-rels`, `recordings`, `media`, `labels`, `artist-credits`, `isrcs`, `work-rels`, `tags`, `genres`, `aliases`). Embedded linked lists are **one page, 25 default / 100 max**.
- **Browse:** `/{type}?{link}={mbid}&limit={≤100}&offset={n}&fmt=json` → `{ {type}-count, {type}-offset, {type}s: […] }`. Distinct pagination envelope from search (`{type}-count`, not `count`). The complete-enumeration path; `offset` pages arbitrarily deep.
- **Identifier endpoints:** `/isrc/{isrc}` → `{ isrc, recordings[] }` (recordings included by default, no `inc` supported — returns 400 if used); `/iswc/{iswc}` → `{ work-count, work-offset, works[] }` (browse-style envelope, works included by default). Barcode is **not** an endpoint — use `/release?query=barcode:{value}`.
- **Relationships:** in lookup payloads under `relations[]`, grouped by `target-type` (`artist` | `url` | `work` | `recording` | …). Each relation carries `type` (the role: `member of band`, `producer`, `engineer`, `conductor`, `writer`, `performance`, …), `attributes[]` (modifiers: `assistant`, `lead vocals`, …), `direction`, and the nested target entity. `url` relations carry external IDs (Wikidata, Discogs, official homepage, streaming, allmusic).
- **Artist credits:** `artist-credit[]` = `[ { name, joinphrase, artist: { id, name } } ]` — `joinphrase` stitches collaborations ("feat.", " & ").
- **Track length** is in **milliseconds** (e.g. `284400` = 4:44).
- **Errors:** `400` `{"error":"Invalid mbid."}` (malformed / zero MBID) · `404` `{"error":"Not Found"}` (valid format, no entity) · `503` + `Retry-After` (rate limit). All error bodies carry a `help` URL.
- **Cover Art Archive:** `https://coverartarchive.org/{release|release-group}/{mbid}` → `{ images: [ { id, front, back, types[], approved, image, thumbnails: { 250, 500, 1200, small, large } } ], release }`. **404 when no art** (HTML body, not JSON — treated as empty, not an error). Art is served at the *release* level; a release-group MBID returns **HTTP 307** redirecting to `archive.org/download/mbid-{release-mbid}/index.json`, which resolves to the same `{ images[], release }` shape — `release` identifies the representative release chosen. The `cover-art-service` must follow redirects; the response shape is identical after the redirect.

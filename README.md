<div align="center">
  <h1>@cyanheads/musicbrainz-mcp-server</h1>
  <p><b>Search artists, releases, recordings, works, and labels; traverse relationships; resolve ISRC/ISWC/barcode; fetch cover art via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.6-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/musicbrainz-mcp-server/releases/latest/download/musicbrainz-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=musicbrainz-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbXVzaWNicmFpbnotbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22musicbrainz-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/musicbrainz-mcp-server%22%5D%7D)

</div>

<div align="center">

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://musicbrainz.caseyjhand.com/mcp](https://musicbrainz.caseyjhand.com/mcp)

</div>

---

## Overview

Open music metadata over the live MusicBrainz Web Service v2 and the Cover Art Archive. Search by name, look up entities by MBID or a standard identifier (ISRC/ISWC/barcode), browse the complete linked set beyond what the lookup tools embed, and fetch cover art from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `musicbrainz_search_entities` | Full-text Lucene search across a MusicBrainz entity type. Returns ranked matches with MBID and a relevance score. |
| `musicbrainz_get_artist` | Artist profile by MBID — type, life span, discography, relationships, external links. |
| `musicbrainz_get_release_group` | Release-group ("the album" above specific pressings) by MBID — type, first-release date, editions, cover-art flag. |
| `musicbrainz_get_release` | One edition's full detail by MBID — tracklist, label, catalog number, barcode, packaging. |
| `musicbrainz_get_recording` | Recording (a specific performance) by MBID — length, ISRCs, releases it appears on, performance relationships. |
| `musicbrainz_get_work` | Work (a composition) by MBID — type, ISWCs, writer relationships, performing recordings. |
| `musicbrainz_get_label` | Label by MBID — type, life span, label code, external links. |
| `musicbrainz_lookup_identifier` | Resolve an ISRC, ISWC, or barcode directly to recordings, works, or releases. |
| `musicbrainz_browse_entities` | Paginate the complete set of entities linked to a parent MBID — the only complete-enumeration path. |
| `musicbrainz_get_cover_art` | Cover Art Archive images for a release or release-group MBID. |

### Resources

| Resource | Description |
|:---|:---|
| `musicbrainz://{entity_type}/{mbid}` | A single MusicBrainz entity by type and MBID, with default linked sub-resources folded in. |

All entity data is also reachable via the `get_*` tools, so tool-only clients lose nothing. There is no resource `list()` — the corpus is millions of entities; discovery is via `musicbrainz_search_entities`.

## Capability reference

### `musicbrainz_search_entities` <sub>tool</sub>

- Searches one entity type per call: artist, release-group, release, recording, work, or label
- Field-scoped Lucene syntax (e.g. `artist:radiohead AND country:GB`)
- Surfaces the raw 0–100 relevance `score` per hit (100 = exact); results stay in MusicBrainz score-descending order, not re-ranked
- Type-specific fields appear only for the relevant entity (ISRCs on recordings, ISWCs on works, artist credit on release-groups/releases/recordings)
- Pagination via `limit` (1–100, default 25) and `offset`; echoes the effective query and the true upstream total

---

### `musicbrainz_get_artist` <sub>tool</sub>

- Folds discography (release-groups), band-membership / collaboration relationships, aliases, and tags/genres into one request via `inc`
- External links (Wikidata QID, Discogs, official site) surface as `url-rels` — chainable to `wikidata-mcp-server` and friends; this server does not chase them itself
- `inc_release_groups` and `inc_relationships` (both default `true`) toggle the expensive sub-resources
- Discography and relationships are capped at one page (25); for a prolific artist's complete release-group list, use `musicbrainz_browse_entities` (`target_type=release-group`, artist link)

---

### `musicbrainz_get_release_group` <sub>tool</sub>

- Primary type (Album, Single, EP, Broadcast, Other) and secondary types (Live, Compilation, Soundtrack, …), first-release date, and the artist credit (array plus a display string)
- Embedded releases (editions) capped at one page (25); `musicbrainz_browse_entities` (`target_type=release`, `link.release-group`) gives the complete set
- Carries a cover-art availability flag from the WS/2 payload — call `musicbrainz_get_cover_art` for the actual image URLs
- Chain a listed release MBID into `musicbrainz_get_release` for its tracklist

---

### `musicbrainz_get_release` <sub>tool</sub>

- Tracklist as media → tracks → recordings, each with length and recording MBID (lengths rendered `m:ss`, stored as milliseconds upstream)
- Label + catalog number, barcode, country, release date, format, packaging, and text representation (language/script)
- Carries a cover-art availability stub from the WS/2 payload; call `musicbrainz_get_cover_art` with the release MBID for the actual image URLs

---

### `musicbrainz_get_recording` <sub>tool</sub>

- Length (rendered `m:ss`), ISRCs, artist credits, and the releases it appears on
- `inc_relationships` (default `true`) toggles performance/production relationships (performer, producer, engineer — each with role and credited-artist MBID) and work-rels linking to the underlying composition
- External links (url-rels) surface alongside relationships when included

---

### `musicbrainz_get_work` <sub>tool</sub>

- Type, ISWCs, lyrics languages, aliases, and tags/genres
- `inc_relationships` (default `true`) toggles writer/composer/lyricist relationships, recording-rels (the recordings that perform it), and external links
- Recording relationships are returned in full — the work lookup is the one `get_*` tool with no per-page cap

---

### `musicbrainz_get_label` <sub>tool</sub>

- Type, country, life span, label code (the LC number), area, aliases, tags, and external links
- Releases are NOT embedded — a major label can have tens of thousands; enumerate them with `musicbrainz_browse_entities` (`target_type=release`, `link.label`)

---

### `musicbrainz_lookup_identifier` <sub>tool</sub>

- `id_type=isrc` → recordings (a recording-level code, often shared by several recordings)
- `id_type=iswc` → works (a composition-level code)
- `id_type=barcode` → releases (UPC/EAN)
- ISRC and ISWC hit dedicated exact endpoints; barcode is a Lucene search filter, so its results are ranked (exact match scores 100)
- The output `kind` field discriminates which entity type came back (recordings | works | releases)

---

### `musicbrainz_browse_entities` <sub>tool</sub>

- Paginates the full linked set: every release-group by an artist, every release on a label, every recording of a work, every release in a release-group
- Page size `limit` (1–100, default 25); pages arbitrarily deep via `offset`, and `totalCount` is the true upstream total
- Use it whenever a linked set may exceed a page — the `get_*` tools embed at most one page (25), and a partial list read as complete is a silent correctness gap
- Provide exactly one `link` MBID matching a valid parent→child relationship for the `target_type`

---

### `musicbrainz_get_cover_art` <sub>tool</sub>

- Front/back flags, image types, full-resolution URLs, and 250/500/1200px thumbnail URLs
- Returns an empty image set (not an error) when the entity has no art — absence of art is information
- Art is served at the release level; `entity_type` defaults to `release`, and a release-group MBID resolves to a representative release's art automatically
- Image URLs are linked, never rehosted — image copyright stays with the rights holders (only the MusicBrainz core metadata is CC0)

---

### `musicbrainz://{entity_type}/{mbid}` <sub>resource</sub>

- Mirrors the matching `musicbrainz_get_*` tool with the same default `inc` sets, returned as the raw MusicBrainz JSON record
- `entity_type` ∈ artist, release-group, release, recording, work, label
- Embedded linked lists are capped at one page, same as the lookup tools — use `musicbrainz_browse_entities` for the complete set

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

MusicBrainz-specific:

- Type-safe client over the MusicBrainz Web Service v2 (`musicbrainz.org/ws/2`, JSON) plus the Cover Art Archive
- Process-wide ~1 req/sec token-bucket rate limiter — concurrent requests serialize to stay under MusicBrainz's per-IP ceiling, so multi-tenant load shares one budget
- Response caching keyed on the full request (including the `inc` set) — MBIDs are stable and entity data changes slowly, keeping most repeat lookups off the wire
- `inc`-driven lookups fold discography, relationships, tracklists, and external IDs into a single call rather than serial requests
- Retry with backoff over the full fetch + parse pipeline; an HTML error page served under load is classified transient, not as a parse error

Agent-friendly output:

- Provenance on search/browse — the effective query is echoed and the true upstream total is reported, so an agent can tell a partial window from a complete result
- Truncation honesty — `get_*` tools disclose when an embedded linked list is capped at one page and name `musicbrainz_browse_entities` as the complete-enumeration path
- Discriminated outputs — `musicbrainz_lookup_identifier` returns a `kind`-tagged union (recordings | works | releases) so callers branch on data, not string parsing
- Raw upstream relevance `score` surfaced as-is (not a fabricated confidence metric), and missing upstream fields are preserved as absent rather than invented

## Getting started

`musicbrainz-mcp-server` is keyless — no API key or account. MusicBrainz does require a descriptive `User-Agent` with a contact and rate-limits to ~1 request/second per IP; the server ships a default contact so it works out of the box, but operators running a shared or hosted instance should set `MUSICBRAINZ_CONTACT` to their own email or URL.

### Public Hosted Instance

A public instance is available at `https://musicbrainz.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP, with this client config:

```json
{
  "mcpServers": {
    "musicbrainz-mcp-server": {
      "type": "streamable-http",
      "url": "https://musicbrainz.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "musicbrainz-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/musicbrainz-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "MUSICBRAINZ_CONTACT": "you@example.com"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "musicbrainz-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/musicbrainz-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "MUSICBRAINZ_CONTACT": "you@example.com"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "musicbrainz-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "MUSICBRAINZ_CONTACT=you@example.com",
        "ghcr.io/cyanheads/musicbrainz-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 MUSICBRAINZ_CONTACT=you@example.com bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key. Optionally set `MUSICBRAINZ_CONTACT` to your email or URL — recommended for any shared or hosted deployment.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/musicbrainz-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd musicbrainz-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set MUSICBRAINZ_CONTACT (optional but recommended)
```

## Configuration

Configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---|:---|:---|
| `MUSICBRAINZ_CONTACT` | Contact (email or URL) embedded in the mandatory descriptive `User-Agent`. Not start-blocking — a default is provided — but operators of a shared/hosted instance should set their own so MusicBrainz can reach them about traffic. | repo URL |
| `MUSICBRAINZ_BASE_URL` | MusicBrainz Web Service v2 base URL. Override for a private mirror or `beta.musicbrainz.org`. | `https://musicbrainz.org/ws/2` |
| `MUSICBRAINZ_RATE_LIMIT_RPS` | Client-side request-per-second ceiling. ~1 is the documented limit; lower it for shared-hosting headroom. | `1` |
| `MUSICBRAINZ_CACHE_TTL` | Response cache TTL in seconds. MBIDs are stable, so data changes slowly. `0` disables caching. | `86400` |
| `MUSICBRAINZ_TIMEOUT_MS` | Per-request HTTP timeout in milliseconds. | `30000` |
| `MUSICBRAINZ_MAX_RETRIES` | Retry attempts for transient upstream failures (503 / 5xx / HTML error page). | `3` |
| `COVER_ART_BASE_URL` | Cover Art Archive base URL. | `https://coverartarchive.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

### Rate limit and User-Agent

MusicBrainz blocks requests without a descriptive `User-Agent` identifying the application and a contact. This server sends `musicbrainz-mcp-server/<version> (<contact>)`, where `<contact>` is `MUSICBRAINZ_CONTACT` — set it to your own email or URL when you deploy. Upstream calls serialize through one process-wide limiter, so on a shared or hosted instance every client draws on the same ~1 req/sec budget and bulk enumeration via `musicbrainz_browse_entities` paces accordingly.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security, packaging
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against the linter rules
  ```

### Docker

```sh
docker build -t musicbrainz-mcp-server .
docker run --rm -e MUSICBRAINZ_CONTACT=you@example.com -p 3010:3010 musicbrainz-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/musicbrainz-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and the resource, inits both services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/services/musicbrainz` | MusicBrainz WS/2 client — User-Agent, rate limiter, response cache, retry, and domain types. |
| `src/services/cover-art` | Cover Art Archive client — maps 404 to an empty image set, follows the release-group redirect. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Ten read-only tools across search, lookup, browse, and cover art. |
| `src/mcp-server/resources` | Resource definitions. The `musicbrainz://{entity_type}/{mbid}` entity mirror. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- All upstream calls route through the services — never `fetch()` MusicBrainz directly, or you bypass the User-Agent, rate limiter, and cache
- Wrap external API data: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Attribution and licensing

MusicBrainz core entity data is released under **CC0** (public-domain dedication) — see the [MusicBrainz license](https://musicbrainz.org/doc/About/Data_License). This server stays on that core metadata and does not fetch annotation text (which carries a different, non-CC0 license). Cover art is served by the [Cover Art Archive](https://coverartarchive.org/), a joint project of MusicBrainz and the Internet Archive; image URLs are linked, never rehosted, and each image's copyright stays with its rights holders. Cite MusicBrainz and the Cover Art Archive in downstream use.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.

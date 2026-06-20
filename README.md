<div align="center">
  <h1>@cyanheads/musicbrainz-mcp-server</h1>
  <p><b>Search artists, releases, recordings, works, and labels; traverse relationships; resolve ISRC/ISWC/barcode; fetch cover art via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

## Tools

Ten read-only tools mapping the three MusicBrainz access modes — **search** when you have text, **lookup** (`get_*` and `lookup_identifier`) when you hold an MBID or standard identifier, and **browse** when you need the complete linked set beyond the single page that lookup folds in:

| Tool | Description |
|:---|:---|
| `musicbrainz_search_entities` | Full-text Lucene search across an entity type (artist, release-group, release, recording, work, label). Returns ranked matches with MBID and a 0–100 relevance score. The first step when starting from a name. |
| `musicbrainz_get_artist` | Artist profile by MBID — type, country, life span, aliases, tags/genres, discography (release-groups), band-membership relationships, and external links. |
| `musicbrainz_get_release_group` | Release-group ("the album" above specific pressings) by MBID — primary/secondary type, first-release date, artist credit, editions, and a cover-art availability flag. |
| `musicbrainz_get_release` | One edition's full detail by MBID — tracklist (media → tracks → recordings), label + catalog number, barcode, packaging, and a cover-art stub. |
| `musicbrainz_get_recording` | Recording (a specific performance/track) by MBID — length, artist credits, ISRCs, the releases it appears on, the work(s) it performs, and performance/production relationships. |
| `musicbrainz_get_work` | Work (a composition, distinct from any recording) by MBID — type, languages, ISWCs, writer/composer relationships, and the recordings that perform it. |
| `musicbrainz_get_label` | Label by MBID — type, country, life span, label code, area, aliases, tags, and external links. |
| `musicbrainz_lookup_identifier` | Resolve a standard identifier without a name search — ISRC → recordings, ISWC → works, barcode → releases. Output is discriminated on the resolved entity type. |
| `musicbrainz_browse_entities` | Paginate the complete set of entities linked to a parent MBID — every release on a label, every release-group by an artist, every recording of a work. The only complete-enumeration path. |
| `musicbrainz_get_cover_art` | Cover Art Archive images for a release or release-group MBID — front/back flags, image types, full-resolution URLs, and 250/500/1200px thumbnails. No art returns an empty set, not an error. |

### `musicbrainz_search_entities`

Resolve a name to an MBID with full-text Lucene search.

- Searches one entity type per call: artist, release-group, release, recording, work, or label
- Field-scoped Lucene syntax (e.g. `artist:radiohead AND country:GB`)
- Surfaces the raw 0–100 relevance `score` per hit (100 = exact); results stay in MusicBrainz score-descending order, not re-ranked
- Type-specific fields appear only for the relevant entity (ISRCs on recordings, ISWCs on works, artist credit on release-groups/releases/recordings)
- Pagination via `limit` (1–100) and `offset`; echoes the effective query and the true upstream total

---

### `musicbrainz_get_artist`

The 80% artist-detail call.

- Folds discography (release-groups), band-membership / collaboration relationships, aliases, and tags/genres into one request via `inc`
- External links (Wikidata QID, Discogs, official site) surface as `url-rels` — chainable to `wikidata-mcp-server` and friends; this server does not chase them itself
- `inc_release_groups` and `inc_relationships` toggle the expensive sub-resources
- Discography and relationships are capped at one page (25); for a prolific artist's complete release-group list, use `musicbrainz_browse_entities` (`target_type=release-group`, artist link)

---

### `musicbrainz_get_release`

One edition's full detail, the level with an actual tracklist.

- Tracklist as media → tracks → recordings, each with length and recording MBID (lengths rendered `m:ss`, stored as milliseconds upstream)
- Label + catalog number, barcode, country, release date, format, packaging, and text representation (language/script)
- Carries a cover-art availability stub from the WS/2 payload; call `musicbrainz_get_cover_art` with the release MBID for the actual image URLs

---

### `musicbrainz_lookup_identifier`

The deterministic path when you already hold a standard identifier — no name search.

- `id_type=isrc` → recordings (a recording-level code, often shared by several recordings)
- `id_type=iswc` → works (a composition-level code)
- `id_type=barcode` → releases (UPC/EAN)
- ISRC and ISWC hit dedicated exact endpoints; barcode is a Lucene search filter, so its results are ranked (exact match scores 100)
- The output `kind` field tells you which entity type came back

---

### `musicbrainz_browse_entities`

The complete-enumeration path — a correctness tool, not just convenience.

- Paginates the full linked set: every release-group by an artist, every release on a label, every recording of a work, every release in a release-group
- Pages arbitrarily deep via `offset`; `totalCount` is the true upstream total
- Use it whenever a linked set may exceed a page — the `get_*` tools embed at most one page (25), and a partial list read as complete is a silent correctness gap
- Provide exactly one `link` MBID matching a valid parent→child relationship for the `target_type`

---

### `musicbrainz_get_cover_art`

Cover Art Archive images, kept separate from the release record.

- Front/back flags, image types, full-resolution URLs, and 250/500/1200px thumbnail URLs
- Returns an empty image set (not an error) when the entity has no art — absence of art is information
- Art is served at the release level; a release-group MBID resolves to a representative release's art automatically
- Image URLs are linked, never rehosted — image copyright stays with the rights holders (only the MusicBrainz core metadata is CC0)

## Resources

| Type | Name | Description |
|:---|:---|:---|
| Resource | `musicbrainz://{entity_type}/{mbid}` | A single MusicBrainz entity by type and MBID, with default linked sub-resources folded in. Mirrors the matching `musicbrainz_get_*` tool. `entity_type` ∈ artist, release-group, release, recording, work, label. |

All entity data is also reachable via the `get_*` tools, so tool-only clients (the majority) lose nothing. There is no resource `list()` — the corpus is millions of entities; discovery is via `musicbrainz_search_entities`, not resource enumeration.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

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

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).
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

MusicBrainz enforces a **~1 request/second** average rate limit per IP across the whole hosted instance and **blocks requests without a descriptive `User-Agent`** that identifies the application and a contact. This server satisfies both: it sends `musicbrainz-mcp-server/<version> (<contact>)` as the `User-Agent` and serializes all upstream calls through a process-wide token-bucket limiter, with response caching to keep repeat lookups off the wire. On a shared or hosted instance every client shares the one limiter, so bulk enumeration via `musicbrainz_browse_entities` paces accordingly. Set `MUSICBRAINZ_CONTACT` to your own email or URL when you deploy.

### Attribution and licensing

MusicBrainz core entity data is released under **CC0** (public-domain dedication) — see the [MusicBrainz license](https://musicbrainz.org/doc/About/Data_License). This server stays on that core metadata and does not fetch annotation text (which carries a different, non-CC0 license). Cover art is served by the [Cover Art Archive](https://coverartarchive.org/), a joint project of MusicBrainz and the Internet Archive; image URLs are linked, never rehosted, and each image's copyright stays with its rights holders. Cite MusicBrainz and the Cover Art Archive in downstream use.

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

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.

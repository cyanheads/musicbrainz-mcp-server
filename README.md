<div align="center">
  <h1>@cyanheads/musicbrainz-mcp-server</h1>
  <p><b>Search artists, releases, recordings, works, and labels; traverse relationships; resolve ISRC/ISWC/barcode; fetch cover art via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.8-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/musicbrainz-mcp-server/releases/latest/download/musicbrainz-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=musicbrainz-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbXVzaWNicmFpbnotbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22musicbrainz-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fmusicbrainz-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://musicbrainz.caseyjhand.com/mcp](https://musicbrainz.caseyjhand.com/mcp)

</div>

---

## Overview

Open music metadata from the live MusicBrainz Web Service v2 and the Cover Art Archive. Search by name, look up entities by MBID or by ISRC, ISWC, or barcode, page through complete linked sets, and fetch cover art. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `musicbrainz_search_entities` | Lucene search over one entity type, returning ranked MBIDs with relevance scores |
| `musicbrainz_get_artist` | Artist profile: type, life span, discography, relationships, external links |
| `musicbrainz_get_release_group` | Release-group (the album across its editions): types, first-release date, editions, cover-art availability |
| `musicbrainz_get_release` | One edition: tracklist, label and catalog number, barcode, packaging |
| `musicbrainz_get_recording` | Recording (one performance): length, ISRCs, releases it appears on, performer and production credits |
| `musicbrainz_get_work` | Work (a composition): type, ISWCs, writers, and the recordings that perform it |
| `musicbrainz_get_label` | Label: type, life span, label code, external links |
| `musicbrainz_lookup_identifier` | Resolve an ISRC, ISWC, or barcode to recordings, works, or releases |
| `musicbrainz_browse_entities` | Page through every entity linked to a parent MBID |
| `musicbrainz_get_cover_art` | Cover Art Archive images for a release or release-group |

### Resources

| Resource | Description |
|:---|:---|
| `musicbrainz://{entity_type}/{mbid}` | One entity as raw MusicBrainz JSON, with the matching `get_*` tool's linked data folded in |

Every entity is also reachable through the `get_*` tools, so tool-only clients lose nothing. The resource has no list; find MBIDs with `musicbrainz_search_entities`.

## Capability reference

### `musicbrainz_search_entities` <sub>tool</sub>

- One `entityType` per call (`artist`, `release-group`, `release`, `recording`, `work`, `label`) and a Lucene `query` with field scoping (`artist:radiohead AND country:GB`); `limit` 1–100 (default 25), `offset` for paging
- Each hit carries `mbid`, `name`, and the raw 0–100 `score` in MusicBrainz order, plus type-specific fields such as `artistCredit`, `isrcs`, `iswcs`, and `length`; a whitespace-only query fails as `blank_query`

---

### `musicbrainz_get_artist` <sub>tool</sub>

- `mbid`, plus `inc_release_groups` and `inc_relationships` (both default `true`) to drop the heavier sub-resources
- Type, gender, country, area, `lifeSpan`, aliases, and tags, plus `releaseGroups` (one page), `relationships` (band membership, collaborations), and `externalLinks` (Wikidata, Discogs, official site)

---

### `musicbrainz_get_release_group` <sub>tool</sub>

- `mbid` only; returns `primaryType`, `secondaryTypes`, `firstReleaseDate`, `artistCredit` with `artistCreditString`, tags, and one page of `releases` (editions)
- `coverArt` (`exists`, `count`, `front`, `back`) comes from a live Cover Art Archive check; when that check fails the field is omitted with a notice, never reported as "no art"

---

### `musicbrainz_get_release` <sub>tool</sub>

- `mbid` only; returns `media` with tracks (`position`, `title`, `length` as m:ss, `recordingId`), `labelInfo` (label and `catalogNumber`), `barcode`, `status`, `date`, `country`, `packaging`, `language`/`script`, and `releaseGroupId`
- `coverArt` is the availability stub from the release record; call `musicbrainz_get_cover_art` for image URLs

---

### `musicbrainz_get_recording` <sub>tool</sub>

- `mbid`, plus `inc_relationships` (default `true`) for performer, producer, and engineer credits, work links to the composition, and external links
- Returns `length`, `isrcs`, `artistCredit`, `firstReleaseDate`, the `releases` it appears on, `relationships`, and `externalLinks`

---

### `musicbrainz_get_work` <sub>tool</sub>

- `mbid`, plus `inc_relationships` (default `true`) for writer, composer, and lyricist credits, the recordings that perform it, and external links
- Returns `type`, `languages`, `iswcs`, aliases, and tags; recording relationships come back in full, with no page cap

---

### `musicbrainz_get_label` <sub>tool</sub>

- `mbid` only; returns type, country, area, `lifeSpan`, `labelCode` (the LC number without its prefix), aliases, tags, and `externalLinks`
- Releases are not embedded; list them with `musicbrainz_browse_entities` (`target_type=release`, `link.label`)

---

### `musicbrainz_lookup_identifier` <sub>tool</sub>

- `id_type` `isrc` → recordings, `iswc` → works, `barcode` → releases; a barcode is UPC/EAN digits and returns up to 25 ranked matches, each with a `score`
- `result.kind` (`recordings` | `works` | `releases`) names the arm that came back; failures are `invalid_identifier` or `identifier_not_found`

---

### `musicbrainz_browse_entities` <sub>tool</sub>

- `target_type` plus exactly one parent MBID in `link` (`artist`, `label`, `release-group`, `recording`, `work`, or `area`); `limit` 1–100 (default 25), `offset` to any depth
- Reports the upstream `totalCount`; while entities remain, `truncated` is set and the notice gives the next `offset`. A missing, extra, or malformed link fails as `invalid_link`, an unknown parent as `entity_not_found`

---

### `musicbrainz_get_cover_art` <sub>tool</sub>

- `mbid` and `entity_type`: `release` (default) or `release-group`, which resolves to a `representativeRelease`
- `images` with `front`/`back`, `types`, `imageUrl`, and 250/500/1200px thumbnails; an entity with no art returns an empty set and `hasArt: false`, not an error
- An archive 404 is checked against MusicBrainz, so an unknown MBID fails as `entity_not_found`; if the check itself fails, the empty set stands with a notice that existence is unconfirmed

---

### `musicbrainz://{entity_type}/{mbid}` <sub>resource</sub>

- `entity_type` is `artist`, `release-group`, `release`, `recording`, `work`, or `label`; returns the raw MusicBrainz record as `application/json`
- Fetches the same default linked data as the matching `get_*` tool; failures are `invalid_mbid` and `entity_not_found`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

MusicBrainz-specific:

- Keyless client for the MusicBrainz Web Service v2 and the Cover Art Archive. Every request carries the descriptive `User-Agent` MusicBrainz requires, `musicbrainz-mcp-server/<version> ( <contact> )`, with `MUSICBRAINZ_CONTACT` as the contact
- Entities are addressed by MBID (a 36-character UUID); every `get_*` tool and the resource fail as `invalid_mbid` for a malformed or all-zeros ID and `entity_not_found` for an unknown one
- One process-wide limiter holds MusicBrainz calls to ~1 request/second, shared by every client of an instance, so long browse runs pace accordingly
- Lookups fold discography, relationships, tracklists, and external links into one request; responses are cached (24 h by default), with retry and backoff on transient 5xx and HTML error pages

Agent-friendly output:

- Truncation honesty: the `get_*` tools and the resource embed at most one page (25) of a linked list (work recordings excepted), and a capped discography or edition list returns `truncated`, `shown`, `cap`, and a notice naming the `musicbrainz_browse_entities` call that lists the rest
- Provenance on search and browse: the effective query is echoed and the upstream total reported, so a partial window never reads as complete
- Discriminated outputs: `musicbrainz_lookup_identifier` returns a `kind`-tagged union, so callers branch on data, not string parsing
- Raw upstream relevance `score`, not a derived confidence; missing upstream fields stay absent rather than invented

## Getting started

### Public Hosted Instance

A public instance is available at `https://musicbrainz.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

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
- No API key or account. The server ships a default contact, but set `MUSICBRAINZ_CONTACT` to your own email or URL for any shared or hosted deployment.

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

| Variable | Description | Default |
|:---|:---|:---|
| `MUSICBRAINZ_CONTACT` | Contact (email or URL) sent in the `User-Agent`. Set your own on a shared or hosted instance so MusicBrainz can reach you about traffic. | repo URL |
| `MUSICBRAINZ_BASE_URL` | MusicBrainz Web Service v2 base URL; override for a private mirror or beta. | `https://musicbrainz.org/ws/2` |
| `MUSICBRAINZ_RATE_LIMIT_RPS` | Client-side requests-per-second ceiling (0.1–50). | `1` |
| `MUSICBRAINZ_CACHE_TTL` | Response cache TTL in seconds; `0` disables caching. | `86400` |
| `MUSICBRAINZ_TIMEOUT_MS` | Per-request HTTP timeout, in ms. | `30000` |
| `MUSICBRAINZ_MAX_RETRIES` | Retry attempts for transient upstream failures. | `3` |
| `COVER_ART_BASE_URL` | Cover Art Archive base URL. | `https://coverartarchive.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

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
| `src/services/musicbrainz` | MusicBrainz WS/2 client — User-Agent, rate limiter, response cache, retry, domain types. |
| `src/services/cover-art` | Cover Art Archive client — maps a 404 to an empty image set, follows the release-group redirect. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Ten read-only tools across search, lookup, browse, and cover art. |
| `src/mcp-server/resources` | Resource definitions. The `musicbrainz://{entity_type}/{mbid}` entity mirror. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Route every upstream call through the services, never a direct `fetch()`, so the User-Agent, rate limiter, and cache apply
- Wrap external API data: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.

MusicBrainz core entity data is [CC0](https://musicbrainz.org/doc/About/Data_License). The server reads only that core metadata and never fetches annotation text, which carries a different license. Cover art comes from the [Cover Art Archive](https://coverartarchive.org/), a joint project of MusicBrainz and the Internet Archive; image URLs are linked, never rehosted, and each image's copyright stays with its rights holders. Cite MusicBrainz and the Cover Art Archive in downstream use.

# Developer Protocol

**Server:** musicbrainz-mcp-server
**Version:** 0.1.6
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.12.3`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.0.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Tools are `musicbrainz_{verb}_{noun}`, all read-only, with typed error contracts encoding the live validation-vs-not-found split (`invalid_mbid` / `entity_not_found`). `search_entities` is the entry point — it resolves a name to an MBID that chains into the `get_*` tools.

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getMusicBrainzService, MusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';

const ENTITY_TYPES = ['artist', 'release-group', 'release', 'recording', 'work', 'label'] as const;

export const searchEntitiesTool = tool('musicbrainz_search_entities', {
  title: 'musicbrainz-mcp-server: search entities',
  description:
    'Full-text Lucene search across a MusicBrainz entity type. Returns ranked matches with MBID, name/title, and a 0–100 relevance score. Chain the MBID into the matching musicbrainz_get_* tool.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    entityType: z.enum(ENTITY_TYPES).describe('Which entity type to search.'),
    query: z.string().min(1).describe('Lucene query string; field scoping (e.g. `artist:`) is supported.'),
    limit: z.number().int().min(1).max(100).default(25).describe('Maximum results to return (1–100).'),
    offset: z.number().int().min(0).default(0).describe('Result offset for pagination (0-based).'),
  }),

  output: z.object({
    entityType: z.string().describe('The entity type that was searched.'),
    results: z.array(ResultSchema).describe('Ranked matches, in MusicBrainz score-descending order.'),
  }),

  // enrich.echo/total/notice surface the effective query, upstream total, and a
  // zero-hits hint — provenance the agent reasons about, not a fabricated score.
  enrichment: {
    effectiveQuery: z.string().describe('The query string as sent to MusicBrainz.'),
    totalCount: z.number().describe('Total matches upstream before the limit/offset window.'),
    notice: z.string().optional().describe('Guidance when zero results matched.'),
  },

  async handler(input, ctx) {
    const service = getMusicBrainzService();
    const envelope = await service.search(input.entityType, input.query, input, ctx, { signal: ctx.signal });
    const rawHits = (envelope[MusicBrainzService.pluralKey(input.entityType)] ?? []) as unknown[];
    const results = rawHits.map((h) => mapHit(input.entityType, h));
    ctx.enrich.echo(input.query);
    ctx.enrich.total(typeof envelope.count === 'number' ? envelope.count : results.length);
    if (results.length === 0) ctx.enrich.notice(`No ${input.entityType} matched "${input.query}".`);
    return { entityType: input.entityType, results };
  },

  // format() populates content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data.
  format: (result) => [{
    type: 'text',
    text: result.results.map((r) => `**${r.name}** — MBID ${r.mbid} (score ${r.score})`).join('\n'),
  }],
});
```

### Resource

One resource template mirrors the `get_*` lookups — the entity type is a path parameter. No `list()`: the corpus is millions of entities, so discovery is via `musicbrainz_search_entities`. The handler maps the service's `ValidationError`/`NotFound` onto the typed `invalid_mbid` / `entity_not_found` contract via `ctx.fail` + `ctx.recoveryFor`.

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';

export const entityResource = resource('musicbrainz://{entity_type}/{mbid}', {
  name: 'musicbrainz-entity',
  title: 'musicbrainz-mcp-server: entity',
  description: 'A single MusicBrainz entity by type and MBID, with default linked sub-resources folded in.',
  mimeType: 'application/json',
  errors: [
    { reason: 'invalid_mbid', code: JsonRpcErrorCode.ValidationError,
      when: 'The MBID is malformed / all-zeros, or entity_type is not one of the six valid types.',
      recovery: 'Use a 36-character UUID MBID and a valid entity_type.' },
    { reason: 'entity_not_found', code: JsonRpcErrorCode.NotFound,
      when: 'The MBID is well-formed but no entity of that type exists with it.',
      recovery: 'Verify the MBID, or find it by name with musicbrainz_search_entities.' },
  ],
  params: z.object({
    entity_type: z.enum(ENTITY_TYPES).describe('Entity type.'),
    mbid: z.string().describe('Entity MBID (36-character UUID).'),
  }),
  async handler(params, ctx) {
    try {
      return await getMusicBrainzService().lookup(params.entity_type, params.mbid, { inc: DEFAULT_INC[params.entity_type] }, ctx, { signal: ctx.signal });
    } catch (error: unknown) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.ValidationError)
        throw ctx.fail('invalid_mbid', `Malformed MBID "${params.mbid}".`, { ...ctx.recoveryFor('invalid_mbid') });
      if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound)
        throw ctx.fail('entity_not_found', `No ${params.entity_type} exists with MBID ${params.mbid}.`, { ...ctx.recoveryFor('entity_not_found') });
      throw error;
    }
  },
});
```

### Prompts

None — this is a data/lookup server with no recurring multi-step interaction worth templating. `createApp()` is called with `prompts: []`.

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

// Treats unset, set-but-empty (""), and an unsubstituted MCPB placeholder
// (${user_config.X}) identically as "not set" so each falls through to the default.
const PLACEHOLDER_PATTERN = /^\$\{[^}]+\}$/;
const emptyAsUndefined = (v: unknown) => {
  if (v === '') return;
  if (typeof v === 'string' && PLACEHOLDER_PATTERN.test(v)) return;
  return v;
};

const ServerConfigSchema = z.object({
  contact: z
    .preprocess(emptyAsUndefined, z.string())
    .default('https://github.com/cyanheads/musicbrainz-mcp-server')
    .describe('Contact (email or URL) embedded in the mandatory MusicBrainz User-Agent'),
  baseUrl: z.string().url().default('https://musicbrainz.org/ws/2').describe('MusicBrainz WS/2 base URL'),
  coverArtBaseUrl: z.string().url().default('https://coverartarchive.org').describe('Cover Art Archive base URL'),
  rateLimitRps: z.coerce.number().min(0.1).max(50).default(1).describe('Client-side MusicBrainz request/sec ceiling'),
  cacheTtlSeconds: z.coerce.number().min(0).max(2_592_000).default(86_400).describe('Response cache TTL in seconds; 0 disables'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    contact: 'MUSICBRAINZ_CONTACT',
    baseUrl: 'MUSICBRAINZ_BASE_URL',
    coverArtBaseUrl: 'COVER_ART_BASE_URL',
    rateLimitRps: 'MUSICBRAINZ_RATE_LIMIT_RPS',
    cacheTtlSeconds: 'MUSICBRAINZ_CACHE_TTL',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`MUSICBRAINZ_CONTACT`) not the path (`contact`). Throws `ConfigurationError`, which the framework prints as a clean startup banner. `MUSICBRAINZ_CONTACT` ships a default so the server runs out of the box; operators of a shared/hosted instance should set their own.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` accepts optional identity fields forwarded to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`):

```ts
await createApp({
  name: 'musicbrainz-mcp-server',
  title: 'musicbrainz-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: [],
  instructions:
    'Entities are addressed by MBID (a UUID); from a name, call musicbrainz_search_entities first and chain the MBID into the matching musicbrainz_get_* tool. The get_* tools embed at most one page (25) of any linked list — use musicbrainz_browse_entities for the complete set. Rate-limited to ~1 request/second against MusicBrainz.',
  setup(core) {
    initMusicBrainzService(core.config.mcpServerVersion);
    initCoverArtService();
  },
});
```

The in-code identity block is `name` + `title` only, both exactly `musicbrainz-mcp-server`. `description` is **not** passed to `createApp()` — the framework derives the served description from `package.json` (the canonical source). `instructions` is optional server-level orientation, sent on every `initialize` as session-level context. Use it for deployment guidance (connection aliases, scope hints, the rate-limit note) instead of repeating the same context across tool descriptions.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Dual-sink: Pino and client-visible `notifications/message`. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.getMany(keys)`, `.list(prefix, options)`. Backs the MusicBrainz response cache. |
| `ctx.requestInput` | Suspend and ask the caller for missing input. Never returns; the handler is re-entered with responses. |
| `ctx.inputs` | Reader over a retried request's responses. Empty on the first round. |
| `ctx.enrich` | Provenance helpers on search/browse — `.echo(query)`, `.total(n)`, `.notice(msg)`. Surface the effective query, upstream total, and a zero-hits hint without polluting the typed output. |
| `ctx.fail` / `ctx.recoveryFor` | Throw a typed contract error by reason (`ctx.fail('invalid_mbid', …)`); `ctx.recoveryFor(reason)` pulls the declared recovery metadata for the throw site. |
| `ctx.signal` | `AbortSignal` for cancellation — forwarded into every upstream fetch. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT; `'default'` for stdio or HTTP with auth off. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire `data.recovery.hint` (mirrored into `content[]` text), pass explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point — registers tools/resources, inits both services
  config/
    server-config.ts                    # MusicBrainz/Cover Art env vars (Zod schema, lazy-parsed)
  services/
    musicbrainz/
      musicbrainz-service.ts            # WS/2 client — User-Agent, rate limiter, cache, withRetry
      rate-limiter.ts                   # Process-wide ~1 req/sec token bucket
      types.ts                          # Raw/domain entity types
    cover-art/
      cover-art-service.ts              # Cover Art Archive client — 404 → empty set, follows 307
  mcp-server/
    tools/definitions/
      search-entities.tool.ts           # musicbrainz_search_entities (the entry point)
      get-artist.tool.ts                # get_artist / get_release_group / get_release /
      get-recording.tool.ts             #   get_recording / get_work / get_label
      lookup-identifier.tool.ts         # musicbrainz_lookup_identifier (ISRC/ISWC/barcode)
      browse-entities.tool.ts           # musicbrainz_browse_entities (complete enumeration)
      get-cover-art.tool.ts             # musicbrainz_get_cover_art
      _shared.ts                        # artist-credit / duration / url-rel helpers
      index.ts                          # allToolDefinitions barrel
    resources/definitions/
      entity.resource.ts                # musicbrainz://{entity_type}/{mbid}
      index.ts                          # allResourceDefinitions barrel
```

No `prompts/` directory — this server registers no prompts.

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-mirror` | MirrorService: stand up a self-refreshing local mirror of a bulk upstream dataset (SQLite + FTS5) — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |
| `techniques` | Cross-cutting implementation techniques and recipes for the framework |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + packaging + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `bun run tree` | Generate `docs/tree.md` directory structure doc |
| `bun run list-skills` | List the skills available in `.claude/skills/` |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run lint:mcp` | Validate MCP tool/resource definitions against the linter rules |
| `bun run lint:packaging` | Validate `manifest.json` ↔ `server.json` env var alignment + bundle/identity guards |
| `bun run test` | Run the Vitest suite |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create the GitHub release from the current tag |

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips dependency-shipped agent docs plus platform-specific native bindings that root-anchored `.mcpbignore` patterns cannot reach. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true only for this project's source-code security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section; use it only for a fix in this server's own source, never for a dependency CVE bump. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import { getCoverArtService } from '@/services/cover-art/cover-art-service.js';
import type { EntityType } from '@/services/musicbrainz/types.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] All upstream calls route through `getMusicBrainzService()` / `getCoverArtService()` — never `fetch()` MusicBrainz directly. The service owns the mandatory descriptive `User-Agent` (with `MUSICBRAINZ_CONTACT`), the process-wide ~1 req/sec rate limiter, and the response cache; a stray fetch bypasses all three.
- [ ] `bun run devcheck` passes

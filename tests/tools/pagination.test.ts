/**
 * @fileoverview Shared page limit switch, telemetry ordering, and composed notices.
 * @module tests/tools/pagination.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: () => ({ add }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  add.mockReset();
  vi.resetModules();
});

describe('page limits', () => {
  it.each(['on', 'off'])(
    'keeps advertised and runtime limits consistent with %s',
    async (setting) => {
      vi.stubEnv('MUSICBRAINZ_CLAMP_OVERSIZED_LIMITS', setting);
      const { PageLimit } = await import('@/mcp-server/tools/definitions/_pagination.js');
      const schema = z.toJSONSchema(z.object({ limit: PageLimit }));
      const field = schema.properties?.limit;
      expect(field).toMatchObject({ type: 'integer', minimum: 1, default: 25 });
      if (setting === 'off') expect(field).toHaveProperty('maximum', 100);
      else expect(field).not.toHaveProperty('maximum', 100);
      expect(PageLimit.safeParse(101).success).toBe(setting === 'on');
      expect(PageLimit.parse(undefined)).toBe(25);
      for (const limit of [0, -1, 1.5]) expect(PageLimit.safeParse(limit).success).toBe(false);
    },
  );

  it.each(['musicbrainz_search_entities', 'musicbrainz_browse_entities'])(
    'logs and counts exactly once for %s',
    async (tool) => {
      const { applyPageLimit } = await import('@/mcp-server/tools/definitions/_pagination.js');
      const ctx = createMockContext();
      const log = vi.spyOn(ctx.log, 'info');
      expect(applyPageLimit(101, tool, ctx)).toBe(100);
      expect(log).toHaveBeenCalledExactlyOnceWith('MusicBrainz page limit clamped', {
        tool,
        requested: 101,
        applied: 100,
      });
      expect(add).toHaveBeenCalledExactlyOnceWith(1, { tool });
      expect(applyPageLimit(100, tool, ctx)).toBe(100);
      expect(applyPageLimit(25, tool, ctx)).toBe(25);
      expect(add).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledOnce();
    },
  );
  it.each([
    [0, 0, 0, 'No matches'],
    [7, 7, 0, 'exhausted'],
    [7, 2, 0, 'empty page'],
    [7, 2, 1, 'offset=3'],
    [7, 6, 1, 'clamped'],
  ])('composes clamp with total %s offset %s shown %s', async (total, offset, shown, detail) => {
    const { pageNotice } = await import('@/mcp-server/tools/definitions/_pagination.js');
    const notice = pageNotice(total, offset, shown, 101, 100, 'No matches');
    expect(notice).toContain('Requested limit 101 was clamped to 100.');
    expect(notice).toContain(detail);
    if (total === 7 && offset === 6) expect(notice).toBe('Requested limit 101 was clamped to 100.');
    if (shown === 0) expect(notice).not.toContain('continue');
  });
});

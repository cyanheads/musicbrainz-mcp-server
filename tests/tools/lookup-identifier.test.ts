/**
 * @fileoverview Tests for the lookup_identifier tool: the three discriminated
 * result arms (recordings / works / releases), identifier_not_found, and barcode
 * validation (digits only after removing spaces/hyphens; anything else —
 * including Lucene syntax — is invalid_identifier before any upstream call).
 * @module tests/tools/lookup-identifier.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const resolveIsrcMock = vi.fn();
const resolveIswcMock = vi.fn();
const searchMock = vi.fn();

vi.mock('@/services/musicbrainz/musicbrainz-service.js', () => ({
  getMusicBrainzService: () => ({
    resolveIsrc: resolveIsrcMock,
    resolveIswc: resolveIswcMock,
    search: searchMock,
  }),
  MusicBrainzService: class {},
}));

const { lookupIdentifierTool } = await import(
  '@/mcp-server/tools/definitions/lookup-identifier.tool.js'
);

afterEach(() => {
  resolveIsrcMock.mockReset();
  resolveIswcMock.mockReset();
  searchMock.mockReset();
});

describe('lookup_identifier', () => {
  it('resolves an ISRC to a recordings arm and surfaces the artist credit', async () => {
    // The ISRC endpoint is now requested with inc=artist-credits, so the
    // credit is populated rather than falling back to "Unknown artist".
    resolveIsrcMock.mockResolvedValueOnce({
      isrc: 'USRC17607839',
      recordings: [
        {
          id: 'rec1',
          title: 'Crazy Eyes',
          length: 184000,
          'artist-credit': [{ name: 'Daryl Hall & John Oates', artist: { id: 'hall-oates' } }],
        },
      ],
    });
    const ctx = createMockContext({ tenantId: 'test', errors: lookupIdentifierTool.errors });
    const input = lookupIdentifierTool.input.parse({ id_type: 'isrc', value: 'USRC17607839' });
    const { result } = await lookupIdentifierTool.handler(input, ctx);
    expect(result.kind).toBe('recordings');
    if (result.kind === 'recordings') {
      expect(result.recordings[0]?.mbid).toBe('rec1');
      expect(result.recordings[0]?.artistCredit).toBe('Daryl Hall & John Oates');
    }
  });

  it('resolves an ISWC to a works arm', async () => {
    resolveIswcMock.mockResolvedValueOnce({
      'work-count': 1,
      works: [{ id: 'w1', title: 'Composition' }],
    });
    const ctx = createMockContext({ tenantId: 'test', errors: lookupIdentifierTool.errors });
    const input = lookupIdentifierTool.input.parse({ id_type: 'iswc', value: 'T-010.140.236-1' });
    const { result } = await lookupIdentifierTool.handler(input, ctx);
    expect(result.kind).toBe('works');
    if (result.kind === 'works') expect(result.works[0]?.title).toBe('Composition');
  });

  it('resolves a barcode to a releases arm via search', async () => {
    searchMock.mockResolvedValueOnce({
      count: 1,
      releases: [{ id: 'rel1', title: 'Album', score: 100, 'artist-credit': [] }],
    });
    const ctx = createMockContext({ tenantId: 'test', errors: lookupIdentifierTool.errors });
    const input = lookupIdentifierTool.input.parse({ id_type: 'barcode', value: '075678164125' });
    const { result } = await lookupIdentifierTool.handler(input, ctx);
    expect(result.kind).toBe('releases');
    if (result.kind === 'releases') expect(result.releases[0]?.score).toBe(100);
    expect(searchMock).toHaveBeenCalledWith(
      'release',
      'barcode:075678164125',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('throws identifier_not_found when an ISRC resolves to zero recordings', async () => {
    resolveIsrcMock.mockResolvedValueOnce({ isrc: 'USRC17607839', recordings: [] });
    const ctx = createMockContext({ tenantId: 'test', errors: lookupIdentifierTool.errors });
    const input = lookupIdentifierTool.input.parse({ id_type: 'isrc', value: 'USRC17607839' });
    await expect(lookupIdentifierTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'identifier_not_found' },
    });
  });
});

describe('lookup_identifier — barcode validation', () => {
  /** A release hit, as the barcode search would return it. */
  const releaseHit = {
    id: 'rel1',
    title: 'Crash',
    score: 100,
    date: '1996-04-30',
    country: 'US',
    'artist-credit': [
      { name: 'Dave Matthews Band', artist: { id: 'dmb', name: 'Dave Matthews Band' } },
    ],
  };

  it.each([
    ['a bare Lucene wildcard', '*'],
    ['digits with a trailing wildcard', '075678*'],
    ['a field-scoped Lucene clause', '075678164125 OR title:x'],
    ['letters', '07567816412A'],
    ['separators only', ' - '],
  ])('rejects %s with invalid_identifier before any search', async (_label, value) => {
    // What the barcode search answers today for Lucene syntax: a broad ranked hit list.
    searchMock.mockResolvedValue({ count: 1, releases: [releaseHit] });
    const ctx = createMockContext({ tenantId: 'test', errors: lookupIdentifierTool.errors });
    const input = lookupIdentifierTool.input.parse({ id_type: 'barcode', value });

    await expect(lookupIdentifierTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_identifier',
        recovery: { hint: expect.stringContaining('barcode') },
      },
    });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['spaces', '0 75678 16412 5'],
    ['hyphens', '0-75678-16412-5'],
    ['no separators', '075678164125'],
  ])('searches the exact digit string for a barcode printed with %s', async (_label, value) => {
    searchMock.mockResolvedValueOnce({ count: 1, releases: [releaseHit] });
    const ctx = createMockContext({ tenantId: 'test', errors: lookupIdentifierTool.errors });
    const input = lookupIdentifierTool.input.parse({ id_type: 'barcode', value });
    const { result } = await lookupIdentifierTool.handler(input, ctx);

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith(
      'release',
      'barcode:075678164125',
      { limit: 25, offset: 0 },
      expect.anything(),
      expect.anything(),
    );
    expect(result).toMatchObject({ kind: 'releases', identifier: '075678164125' });
  });

  it('renders the releases arm on both surfaces for a spaced barcode', async () => {
    searchMock.mockResolvedValueOnce({ count: 1, releases: [releaseHit] });
    const outcome = await runToolContract(lookupIdentifierTool, {
      id_type: 'barcode',
      value: '0 75678 16412 5',
    });

    expect(outcome.isError).toBeFalsy();
    const structured = outcome.structuredContent as {
      result: { kind: string; identifier: string; releases: { mbid: string; score: number }[] };
    };
    expect(structured.result.kind).toBe('releases');
    expect(structured.result.identifier).toBe('075678164125');
    expect(structured.result.releases).toHaveLength(1);
    expect(structured.result.releases[0]).toMatchObject({ mbid: 'rel1', score: 100 });

    const text = (outcome.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Identifier lookup: 075678164125');
    expect(text).toContain('Crash');
    expect(text).toContain('Dave Matthews Band');
    expect(text).toContain('rel1');
  });

  it('carries the barcode rule in the invalid_identifier error on both surfaces', async () => {
    const outcome = await runToolContract(lookupIdentifierTool, { id_type: 'barcode', value: '*' });

    expect(outcome.isError).toBe(true);
    const error = (
      outcome.structuredContent as {
        error: { code: number; data: { reason: string; recovery: { hint: string } } };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('invalid_identifier');
    expect(error.data.recovery.hint).toContain('digits');

    const text = (outcome.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('(reason invalid_identifier');
    expect(text).toContain(`Recovery: ${error.data.recovery.hint}`);
    expect(searchMock).not.toHaveBeenCalled();
  });
});

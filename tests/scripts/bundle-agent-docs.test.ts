/** @fileoverview Bundle pruning preserves dependency runtime modules. @module tests/scripts/bundle-agent-docs */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY as cleaner } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as linter } from '../../scripts/lint-packaging.js';

describe('dependency agent documentation selection', () => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.d.ts',
    'node_modules/example/dist/skills/runtime.js',
  ])('preserves runtime path %s', (entry) => {
    expect(cleaner.test(entry)).toBe(false);
    expect(linter.test(entry)).toBe(false);
  });

  it.each([
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
    'node_modules/example/skills/guide/SKILL.md',
    'node_modules/example/.claude/agent.md',
    'node_modules/outer/node_modules/@scope/inner/skills/guide/SKILL.md',
  ])('removes package-root agent documentation %s', (entry) => {
    expect(cleaner.test(entry)).toBe(true);
    expect(linter.test(entry)).toBe(true);
  });
});

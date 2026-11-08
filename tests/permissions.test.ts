import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_AGENT_PERMISSIONS, OfficePermissions, roleForStation } from '../src/server/permissions.js';
import { claude } from '../src/server/providers/claude.js';

test('office permission choices persist per role and leave other roles untouched', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-permissions-'));
  try {
    let broadcasts = 0;
    const permissions = new OfficePermissions(dir, () => broadcasts++);
    assert.deepEqual(permissions.state().roles, DEFAULT_AGENT_PERMISSIONS);
    assert.equal(permissions.set('worker', 'pushBranch', false, 'Admin'), undefined);
    assert.equal(permissions.allows('worker', 'pushBranch'), false);
    assert.equal(permissions.allows('issues', 'pushBranch'), false);
    assert.equal(broadcasts, 1);
    const restored = new OfficePermissions(dir, () => {});
    assert.equal(restored.allows('worker', 'pushBranch'), false);
    assert.equal(restored.allows('worker', 'officeState'), true);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'permissions.json'), 'utf8')).by, 'Admin');
    assert.match(permissions.set('admin', 'pushBranch', true, 'Admin') ?? '', /role/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('station IDs resolve to their user-facing permission roles', () => {
  assert.equal(roleForStation('issues'), 'issues');
  assert.equal(roleForStation('queue'), 'planning');
  assert.equal(roleForStation('pulls'), 'pulls');
  assert.equal(roleForStation(undefined), 'worker');
});

test('Claude receives only the MCP allows enabled for its role', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-claude-permissions-'));
  try {
    const plan = claude.launch({
      h: { info: {} } as never,
      args: [],
      cwd: dir,
      setup: { settings: path.join(dir, 'claude-hooks.json') },
      permissions: { role: 'planning', choices: { officeState: false, agentDiscussion: true, pushBranch: false } },
    });
    const settingsPath = plan.args[plan.args.indexOf('--settings') + 1];
    assert.notEqual(settingsPath, path.join(dir, 'claude-hooks.json'));
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.allow, ['mcp__agent-office__tell_worker']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

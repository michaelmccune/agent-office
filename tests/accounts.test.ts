import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Accounts } from '../src/server/accounts.js';

function temporaryAccounts() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-office-accounts-'));
  return { accounts: new Accounts(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function makeAdmin(accounts: Accounts, name: string) {
  const invite = accounts.invite('test', 'admin', name);
  assert.notEqual(typeof invite, 'string');
  const account = await accounts.join(invite.token, '', 'test-password');
  assert.notEqual(typeof account, 'string');
  return account;
}

test('when the shared password is off, the last admin cannot be revoked or demoted', async () => {
  const { accounts, cleanup } = temporaryAccounts();
  try {
    const admin = await makeAdmin(accounts, 'Ada');
    accounts.setSharedPassword(false);

    assert.match(String(accounts.revoke(admin.id)), /last admin/);
    assert.match(String(accounts.setRole(admin.id, 'member')), /last admin/);
    assert.equal(accounts.get(admin.id)?.role, 'admin');
  } finally {
    cleanup();
  }
});

test('another admin can be removed or demoted without removing the final admin', async () => {
  const { accounts, cleanup } = temporaryAccounts();
  try {
    const ada = await makeAdmin(accounts, 'Ada');
    const grace = await makeAdmin(accounts, 'Grace');
    accounts.setSharedPassword(false);

    assert.equal(accounts.setRole(grace.id, 'member')?.role, 'member');
    assert.match(String(accounts.setRole(ada.id, 'member')), /last admin/);
    assert.equal(accounts.revoke(grace.id)?.name, 'Grace');
    assert.equal(accounts.get(ada.id)?.role, 'admin');
  } finally {
    cleanup();
  }
});

test('the last admin may be removed while the shared password remains as a fallback', async () => {
  const { accounts, cleanup } = temporaryAccounts();
  try {
    const admin = await makeAdmin(accounts, 'Ada');

    assert.equal(accounts.revoke(admin.id)?.name, 'Ada');
    assert.equal(accounts.sharedPassword, true);
  } finally {
    cleanup();
  }
});

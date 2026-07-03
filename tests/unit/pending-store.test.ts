import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/db/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/db/index.js')>();
  return { ...orig, getDb: () => testDb };
});
vi.mock('../../src/util/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { SCHEMA } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrations.js';
import { PendingMessageStore } from '../../src/session/pending-store.js';

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(SCHEMA);
  runMigrations(testDb);
});
afterEach(() => testDb.close());

describe('pending_messages claim/dispatch (H13 regression guard)', () => {
  it('claim marks a row processing and a second claim does not re-pick it', () => {
    PendingMessageStore.enqueueUser('default', 'hello');
    const first = PendingMessageStore.claimBatch(10);
    expect(first).toHaveLength(1);
    // The row is flipped to 'processing' in the DB by the claim.
    const dbStatus = (
      testDb.prepare('SELECT status FROM pending_messages WHERE id = ?').get(first[0].id) as {
        status: string;
      }
    ).status;
    expect(dbStatus).toBe('processing');

    // Claim-before-dispatch: the in-flight row must not be re-claimed.
    const second = PendingMessageStore.claimBatch(10);
    expect(second).toHaveLength(0);
  });

  it('carries ref_id on delegation rows for completion correlation', () => {
    PendingMessageStore.enqueueDelegation('default', 'do it', 'deleg-123');
    const [row] = PendingMessageStore.claimBatch(10);
    expect(row.type).toBe('delegation');
    expect(row.refId).toBe('deleg-123');
  });

  it('markDone transitions the row out of processing', () => {
    PendingMessageStore.enqueueUser('default', 'x');
    const [row] = PendingMessageStore.claimBatch(10);
    PendingMessageStore.markDone(row.id);
    const status = (
      testDb.prepare('SELECT status FROM pending_messages WHERE id = ?').get(row.id) as {
        status: string;
      }
    ).status;
    expect(status).toBe('done');
  });
});

describe('stuck-processing recovery (M2 — keyed off claimed_at)', () => {
  it('does NOT recover a freshly-claimed row', () => {
    PendingMessageStore.enqueueUser('default', 'x');
    PendingMessageStore.claimBatch(10); // claimed_at = now
    expect(PendingMessageStore.recoverProcessing()).toBe(0);
  });

  it('recovers a row whose claimed_at is older than the stale window', () => {
    PendingMessageStore.enqueueUser('default', 'x');
    const [row] = PendingMessageStore.claimBatch(10);
    // Backdate claimed_at well beyond the 45-minute window.
    testDb
      .prepare("UPDATE pending_messages SET claimed_at = datetime('now', '-2 hours') WHERE id = ?")
      .run(row.id);
    expect(PendingMessageStore.recoverProcessing()).toBe(1);
    const status = (
      testDb.prepare('SELECT status FROM pending_messages WHERE id = ?').get(row.id) as {
        status: string;
      }
    ).status;
    expect(status).toBe('pending');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

// Keep the real SCHEMA (so we build the true migrated schema, not a hand-copy)
// but point getDb at the in-memory test DB.
vi.mock('../../src/db/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/db/index.js')>();
  return { ...orig, getDb: () => testDb };
});

vi.mock('../../src/util/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { SCHEMA } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrations.js';
import { createDelegation, completeDelegation } from '../../src/delegation/manager.js';

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(SCHEMA);
  runMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

describe('delegation completion correlates by id (H2)', () => {
  it('an unrelated completion on the target tab does NOT complete a delegation', () => {
    const d = createDelegation('a', 'b', 'do the thing', 'a');
    // Simulate an unrelated run finishing on tab "b" — the old code would have
    // grabbed "newest pending delegation to b" and completed d with this result.
    // completeDelegation now requires the specific id, so calling it with a
    // bogus/unknown id must NOT touch d.
    expect(completeDelegation('some-other-run-id', 'unrelated output')).toBeNull();
    const row = testDb.prepare('SELECT status, result FROM delegations WHERE id = ?').get(d.id) as {
      status: string;
      result: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.result).toBeNull();
  });

  it('completing by the delegation id closes exactly that delegation', () => {
    const d1 = createDelegation('a', 'b', 'first', 'a');
    const d2 = createDelegation('a', 'b', 'second', 'a');
    const done = completeDelegation(d2.id, 'result for second');
    expect(done?.id).toBe(d2.id);
    const s1 = testDb.prepare('SELECT status FROM delegations WHERE id = ?').get(d1.id) as {
      status: string;
    };
    const s2 = testDb.prepare('SELECT status, result FROM delegations WHERE id = ?').get(d2.id) as {
      status: string;
      result: string;
    };
    expect(s1.status).toBe('pending'); // untouched
    expect(s2.status).toBe('completed');
    expect(s2.result).toBe('result for second');
  });
});

describe('delegation depth accumulates along a chain (H3)', () => {
  it('a chain a→b→c→d hits MAX_DELEGATION_DEPTH (3)', () => {
    // Each hop stays pending (as in a live chain fulfilling the previous hop).
    expect(createDelegation('a', 'b', 'm', 'a').depth).toBe(1);
    expect(createDelegation('b', 'c', 'm', 'b').depth).toBe(2);
    expect(createDelegation('c', 'd', 'm', 'c').depth).toBe(3);
    // Fourth hop from d must be blocked — the old source-only depth counted
    // every hop as depth 1 and never tripped the limit.
    expect(() => createDelegation('d', 'e', 'm', 'd')).toThrow(/depth limit/i);
  });
});

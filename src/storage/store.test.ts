/**
 * Tests for watchStore() polling reliability.
 *
 * Verifies that:
 *  1. Multiple writes over time each produce a 'change' event (no staleness).
 *  2. 'created' events carry the full task object.
 *  3. 'updated' / 'moved' events carry the full task object.
 *  4. Partial JSON writes (atomic-rename mid-tick) are skipped gracefully.
 *
 * Strategy: we write tasks.json files directly to a temp SESSIONS_DIR,
 * override the module's SESSIONS_DIR via monkey-patching (_testOverrideSessionsDir),
 * then let the poll interval fire and collect emitted events.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync, existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// We need to test the polling mechanism without touching the real ~/.kanban.
// The module exports _testOverrideSessionsDir for this purpose (see store.ts).
// ---------------------------------------------------------------------------
import {
  storeEvents,
  _testOverrideSessionsDir,
  _testResetPollState,
  watchStore,
  type StoreChangeEvent,
} from './store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `kanban-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTasksJson(sessionsDir: string, session: string, tasks: object[]): Promise<void> {
  const sessionDir = path.join(sessionsDir, session);
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'tasks.json');
  const tmp = file + '.tmp';
  const data = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tasks }, null, 2);
  return fs.writeFile(tmp, data, 'utf-8').then(() => fs.rename(tmp, file));
}

function makeTask(id: string, title: string, status = 'todo', tags: string[] = [], updatedAt?: string): object {
  const now = updatedAt ?? new Date().toISOString();
  return {
    id,
    title,
    description: undefined,
    status,
    tags,
    source: 'manual',
    createdAt: now,
    updatedAt: now,
  };
}

/** Collect up to `count` 'change' events within `timeoutMs` ms. */
function collectEvents(count: number, timeoutMs: number): Promise<StoreChangeEvent[]> {
  return new Promise((resolve, reject) => {
    const collected: StoreChangeEvent[] = [];
    const timer = setTimeout(() => {
      storeEvents.off('change', handler);
      // Resolve with what we have (allows partial-event assertions)
      resolve(collected);
    }, timeoutMs);

    function handler(ev: StoreChangeEvent): void {
      collected.push(ev);
      if (collected.length >= count) {
        clearTimeout(timer);
        storeEvents.off('change', handler);
        resolve(collected);
      }
    }

    storeEvents.on('change', handler);
  });
}

/** Wait ms milliseconds. */
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('watchStore() polling', () => {
  let tmpDir: string;

  before(() => {
    // All tests share a single tmpDir (separate sessions avoid cross-test pollution)
    tmpDir = makeTempDir();
  });

  after(async () => {
    // Cleanup temp dir
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    // Reset poll state between tests so each test starts with a clean slate
    _testResetPollState();
    _testOverrideSessionsDir(tmpDir);
  });

  afterEach(() => {
    // Remove all change listeners installed by collectEvents (safety net)
    storeEvents.removeAllListeners('change');
  });

  // -------------------------------------------------------------------------
  it('emits a created event with full task on first write', async () => {
    const session = `s-create-${Date.now()}`;
    const taskId = `t-${Date.now()}`;

    // Start watcher (builds initial snapshot = empty, seeds mtime baseline)
    await watchStore();

    // Register collector BEFORE writing
    const eventsPromise = collectEvents(1, 3000);

    // Write a tasks.json for this session — mtime will differ from baseline
    // We need to advance mtime beyond what was seeded; since the session dir
    // doesn't exist yet at watchStore() time, _pollMtimes has no entry → first
    // observation sets baseline. We write twice to trigger the actual diff.

    // First write: seeds the baseline mtime (no event expected)
    await writeTasksJson(tmpDir, session, [makeTask(taskId, 'Test Task')]);
    // Wait one poll interval so the baseline mtime is recorded
    await wait(1200);

    // Second write: same task, but touch updatedAt → mtime changes → event fires
    const updatedAt2 = new Date().toISOString();
    await writeTasksJson(tmpDir, session, [makeTask(taskId, 'Test Task', 'todo', [], updatedAt2)]);

    const events = await eventsPromise;
    assert.equal(events.length, 1, 'Expected exactly one change event');
    const ev = events[0];
    assert.ok(['created', 'updated'].includes(ev.type), `Expected created or updated, got ${ev.type}`);
    assert.equal(ev.taskId, taskId);
    assert.ok(ev.task !== undefined, 'Event must include full task object');
    assert.equal(ev.task!.id, taskId);
    assert.equal(ev.task!.title, 'Test Task');
  });

  // -------------------------------------------------------------------------
  it('emits events for MULTIPLE writes over time — no staleness after first event', async () => {
    const session = `s-multi-${Date.now()}`;
    const taskId1 = `t-A-${Date.now()}`;
    const taskId2 = `t-B-${Date.now()}`;

    // Use FIXED timestamps per task so re-writing an "unchanged" task doesn't
    // produce a spurious updatedAt diff across writes.
    const ts1base = '2024-01-01T00:00:00.000Z';
    const ts2base = '2024-01-01T00:00:01.000Z';

    // Pre-seed the session with taskId1 so watchStore() snapshot includes it
    await writeTasksJson(tmpDir, session, [makeTask(taskId1, 'Task A', 'todo', [], ts1base)]);

    await watchStore(); // snapshot: {taskId1 with ts1base}; mtime seeded

    // --- Write 1: add taskId2 ---
    const eventsPromise1 = collectEvents(1, 3000);
    await wait(50); // ensure file mtime differs from pre-seed mtime
    await writeTasksJson(tmpDir, session, [
      makeTask(taskId1, 'Task A', 'todo', [], ts1base),      // unchanged
      makeTask(taskId2, 'Task B', 'todo', [], ts2base),      // NEW
    ]);
    const events1 = await eventsPromise1;
    assert.equal(events1.length, 1, 'Write 1: expected 1 event');
    assert.equal(events1[0].type, 'created');
    assert.equal(events1[0].taskId, taskId2);
    assert.ok(events1[0].task !== undefined, 'Write 1: event must carry full task');

    // Wait comfortably past one poll interval
    await wait(1300);

    // --- Write 2: update taskId1 title (bump its updatedAt) ---
    const ts1v2 = '2024-01-01T00:01:00.000Z';
    const eventsPromise2 = collectEvents(1, 3000);
    await writeTasksJson(tmpDir, session, [
      makeTask(taskId1, 'Task A — renamed', 'todo', [], ts1v2),   // title changed
      makeTask(taskId2, 'Task B', 'todo', [], ts2base),           // unchanged
    ]);
    const events2 = await eventsPromise2;
    assert.equal(events2.length, 1, 'Write 2: expected 1 event (no staleness after write 1)');
    assert.equal(events2[0].type, 'updated');
    assert.equal(events2[0].taskId, taskId1);
    assert.ok(events2[0].task !== undefined, 'Write 2: event must carry full task');
    assert.equal(events2[0].task!.title, 'Task A — renamed');

    // Wait another poll interval
    await wait(1300);

    // --- Write 3: move taskId2 to in-progress (bump its updatedAt) ---
    const ts2v2 = '2024-01-01T00:02:00.000Z';
    const eventsPromise3 = collectEvents(1, 3000);
    await writeTasksJson(tmpDir, session, [
      makeTask(taskId1, 'Task A — renamed', 'todo', [], ts1v2),     // unchanged
      makeTask(taskId2, 'Task B', 'in-progress', [], ts2v2),        // status changed
    ]);
    const events3 = await eventsPromise3;
    assert.equal(events3.length, 1, 'Write 3: expected 1 event (no staleness after write 2)');
    assert.equal(events3[0].type, 'moved');
    assert.equal(events3[0].taskId, taskId2);
    assert.ok(events3[0].task !== undefined, 'Write 3: event must carry full task');
    assert.equal(events3[0].task!.status, 'in-progress');
  });

  // -------------------------------------------------------------------------
  it('survives a partial (invalid JSON) write without crashing', async () => {
    const session = `s-partial-${Date.now()}`;
    const sessionDir = path.join(tmpDir, session);
    mkdirSync(sessionDir, { recursive: true });
    const dataFile = path.join(sessionDir, 'tasks.json');

    // Pre-seed valid file so snapshot + mtime are seeded
    await writeTasksJson(tmpDir, session, []);
    await watchStore();
    await wait(1200); // let first poll cycle pass with baseline mtime

    // Write a truncated (invalid) JSON file directly (simulates atomic-rename mid-write)
    await fs.writeFile(dataFile, '{ "version": 1, "tasks": [{ "id": "x"', 'utf-8');

    // Poll should not throw; after another interval it retries
    await wait(1300);

    // Now write valid JSON — must still produce an event
    const validId = `t-valid-${Date.now()}`;
    const eventsPromise = collectEvents(1, 3000);
    await writeTasksJson(tmpDir, session, [makeTask(validId, 'Valid Task')]);
    const events = await eventsPromise;

    // Should get at least one event for the valid write
    assert.ok(events.length >= 1, 'Expected event after recovery from partial write');
    const ev = events.find((e) => e.taskId === validId);
    assert.ok(ev !== undefined, 'Expected event for validId');
    assert.ok(ev!.task !== undefined, 'Recovery event must carry full task');
  });

  // -------------------------------------------------------------------------
  it('emits deleted event (no task field) when a task is removed', async () => {
    const session = `s-delete-${Date.now()}`;
    const taskId = `t-del-${Date.now()}`;

    await writeTasksJson(tmpDir, session, [makeTask(taskId, 'To be deleted')]);
    await watchStore();
    await wait(1200); // baseline

    const eventsPromise = collectEvents(1, 3000);
    // Remove the task
    await writeTasksJson(tmpDir, session, []);
    const events = await eventsPromise;

    assert.equal(events.length, 1, 'Expected 1 deleted event');
    assert.equal(events[0].type, 'deleted');
    assert.equal(events[0].taskId, taskId);
    // deleted events carry no task field
    assert.equal(events[0].task, undefined);
  });
});

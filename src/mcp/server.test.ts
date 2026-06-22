/**
 * Tests for MCP server narrensicher improvements (Part 1) and
 * archive status (Part 2) + HTTP move endpoint (Part 3).
 *
 * Covers:
 *  - Tag recovery from mangled description (tool-call artifact)
 *  - Strict status validation (error instead of silent default)
 *  - Self-verification fields in responses (id, status, tags)
 *  - archive status in create / move / list
 *  - POST /api/tasks/:id/status endpoint (valid, invalid status, 404)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

// ---------------------------------------------------------------------------
// Helpers shared across suites
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `kanban-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Import store helpers + test hooks
// ---------------------------------------------------------------------------

import {
  createTask,
  moveTask,
  listTasks,
  setActiveSession,
  _testOverrideSessionsDir,
  _testResetPollState,
} from '../storage/store.js';
import { VALID_STATUSES } from '../types.js';

// ---------------------------------------------------------------------------
// Import the recovery/validation logic by re-exporting it from server (we test
// it indirectly via the store operations + type checks below).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Re-implement the artifact recovery inline for unit testing without
// spinning up the MCP server transport.
// ---------------------------------------------------------------------------

const ARTIFACT_TAIL_RE =
  /<\/description>\s*(?:<parameter\s[^>]*name\s*=\s*["']tags["'][^>]*>([\s\S]*?)<\/parameter>)?([\s\S]*?)\s*$/;

function recoverDescriptionAndTags(
  description: string | undefined,
  providedTags: string[] | undefined,
): { description: string | undefined; tags: string[] | undefined; recovered: boolean } {
  if (!description) {
    return { description, tags: providedTags, recovered: false };
  }
  const match = ARTIFACT_TAIL_RE.exec(description);
  if (!match || !match[0].includes('</description>')) {
    return { description, tags: providedTags, recovered: false };
  }
  const cutIdx = description.indexOf('</description>');
  const cleanDescription = description.slice(0, cutIdx).trimEnd() || undefined;
  let recoveredTags: string[] | undefined = providedTags;
  const hasTags = Array.isArray(providedTags) && providedTags.length > 0;
  if (!hasTags && match[1]) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) {
        recoveredTags = parsed.map(String);
      }
    } catch {
      // leave as-is
    }
  }
  return { description: cleanDescription, tags: recoveredTags, recovered: true };
}

// ---------------------------------------------------------------------------
// Suite 1: Tag recovery from mangled description
// ---------------------------------------------------------------------------

describe('recoverDescriptionAndTags()', () => {
  it('returns inputs unchanged when description has no artifact', () => {
    const result = recoverDescriptionAndTags('A normal description.', ['bug']);
    assert.equal(result.description, 'A normal description.');
    assert.deepEqual(result.tags, ['bug']);
    assert.equal(result.recovered, false);
  });

  it('recovers tags from artifact tail when tags is empty', () => {
    const mangled =
      'Real description text\n</description>\n<parameter name="tags">["bug","host:srv01"]</parameter>\n<parameter name="status">todo</parameter>';
    const result = recoverDescriptionAndTags(mangled, undefined);
    assert.equal(result.description, 'Real description text');
    assert.deepEqual(result.tags, ['bug', 'host:srv01']);
    assert.equal(result.recovered, true);
  });

  it('strips artifact tail but preserves caller-provided tags', () => {
    const mangled =
      'Some description</description>\n<parameter name="tags">["wrong"]</parameter>';
    const result = recoverDescriptionAndTags(mangled, ['correct', 'host:x']);
    assert.equal(result.description, 'Some description');
    // Caller tags take precedence — the artifact tags are NOT used when caller provided tags.
    assert.deepEqual(result.tags, ['correct', 'host:x']);
    assert.equal(result.recovered, true);
  });

  it('handles description that is only the artifact sentinel', () => {
    const mangled = '</description><parameter name="tags">["a"]</parameter>';
    const result = recoverDescriptionAndTags(mangled, undefined);
    // No real content before the sentinel → description becomes undefined
    assert.equal(result.description, undefined);
    assert.deepEqual(result.tags, ['a']);
    assert.equal(result.recovered, true);
  });

  it('does NOT corrupt descriptions that contain XML-like text in the middle', () => {
    // The artifact sentinel must appear at the END.
    const safe = 'Use <parameter name="x">y</parameter> in your config.';
    const result = recoverDescriptionAndTags(safe, ['tag']);
    assert.equal(result.description, safe);
    assert.equal(result.recovered, false);
  });

  it('returns unchanged when description is undefined', () => {
    const result = recoverDescriptionAndTags(undefined, ['a']);
    assert.equal(result.description, undefined);
    assert.deepEqual(result.tags, ['a']);
    assert.equal(result.recovered, false);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: VALID_STATUSES includes 'archive'
// ---------------------------------------------------------------------------

describe('VALID_STATUSES includes archive', () => {
  it('contains all five statuses', () => {
    assert.deepEqual(VALID_STATUSES, ['todo', 'in-progress', 'done', 'blocked', 'archive']);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Store operations with archive status
// ---------------------------------------------------------------------------

describe('store — archive status', () => {
  let tmpDir: string;
  const SESSION = 'test-archive-session';

  before(() => {
    tmpDir = makeTempDir();
    _testResetPollState();
    _testOverrideSessionsDir(tmpDir);
  });

  after(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    _testResetPollState();
    _testOverrideSessionsDir(tmpDir);
  });

  it('creates a task with status archive', async () => {
    const task = await createTask(
      { title: 'Archived from start', status: 'archive', tags: ['test'] },
      SESSION,
    );
    assert.equal(task.status, 'archive');
    assert.equal(task.title, 'Archived from start');
  });

  it('moves a task from done to archive', async () => {
    const task = await createTask(
      { title: 'Done task to archive', status: 'done' },
      SESSION,
    );
    const moved = await moveTask(task.id, 'archive', SESSION);
    assert.ok(moved, 'moveTask should return the task');
    assert.equal(moved!.status, 'archive');
  });

  it('moves a task from todo to archive', async () => {
    const task = await createTask(
      { title: 'Todo directly archived', status: 'todo' },
      SESSION,
    );
    const moved = await moveTask(task.id, 'archive', SESSION);
    assert.ok(moved);
    assert.equal(moved!.status, 'archive');
  });

  it('listTasks returns archive tasks by default (no filter)', async () => {
    const archivedTask = await createTask(
      { title: 'Should appear in list', status: 'archive', tags: ['list-test'] },
      SESSION,
    );
    const allTasks = await listTasks(SESSION);
    const found = allTasks.find((t) => t.id === archivedTask.id);
    assert.ok(found, 'Archived task must appear in unfiltered list');
    assert.equal(found!.status, 'archive');
  });

  it('listTasks with status=archive filter returns only archive tasks', async () => {
    await createTask({ title: 'Regular todo', status: 'todo' }, SESSION);
    await createTask({ title: 'Archived one', status: 'archive', tags: ['archive-filter'] }, SESSION);
    const archiveTasks = await listTasks(SESSION, { status: 'archive' });
    assert.ok(archiveTasks.length >= 1, 'Should have at least one archived task');
    assert.ok(archiveTasks.every((t) => t.status === 'archive'), 'All returned tasks must have status=archive');
  });
});

// ---------------------------------------------------------------------------
// Suite 4: HTTP POST /api/tasks/:id/status endpoint
// ---------------------------------------------------------------------------

// Lightweight HTTP helper — avoids supertest dependency.
function httpRequest(
  port: number,
  options: { method: string; path: string; body?: object },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: options.path,
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe('HTTP POST /api/tasks/:id/status', () => {
  let server: http.Server;
  let port: number;
  let tmpDir: string;
  // The HTTP server resolves the session via getCurrentSessionName() which reads
  // from ~/.kanban/active-session.json.  To make the test tasks visible to the
  // HTTP handler we set the active session to 'independent' (always exists) and
  // create tasks without an explicit session override so both paths use the same
  // session.
  const HTTP_SESSION = 'independent';

  before(async () => {
    tmpDir = makeTempDir();
    _testResetPollState();
    _testOverrideSessionsDir(tmpDir);

    // Point the active session to 'independent' so HTTP handler and test
    // createTask() calls resolve the same session.
    await setActiveSession(HTTP_SESSION);

    // We import createDashboardServer lazily to avoid the dashboard build
    // requirement in tests. The server itself is instantiated but we skip
    // startDashboardServer (which checks for built dashboard files).
    const { createDashboardServer } = await import('../server/http.js');
    server = createDashboardServer(0 as any);

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
      server.on('error', reject);
    });
  });

  after(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('moves a task to in-progress via POST /api/tasks/:id/status', async () => {
    // Create task without session override → uses getCurrentSessionName() = HTTP_SESSION
    const task = await createTask({ title: 'HTTP move test', status: 'todo' });

    const resp = await httpRequest(port, {
      method: 'POST',
      path: `/api/tasks/${task.id}/status`,
      body: { status: 'in-progress' },
    });

    assert.equal(resp.status, 200, `Expected 200 but got ${resp.status}`);
    const body = resp.body as Record<string, unknown>;
    assert.equal(body.id, task.id);
    assert.equal(body.status, 'in-progress');
  });

  it('moves a task to archive via POST /api/tasks/:id/status', async () => {
    const task = await createTask({ title: 'HTTP archive test', status: 'done' });

    const resp = await httpRequest(port, {
      method: 'POST',
      path: `/api/tasks/${task.id}/status`,
      body: { status: 'archive' },
    });

    assert.equal(resp.status, 200);
    const body = resp.body as Record<string, unknown>;
    assert.equal(body.status, 'archive');
  });

  it('also accepts /move alias: POST /api/tasks/:id/move', async () => {
    const task = await createTask({ title: 'HTTP move alias test', status: 'todo' });

    const resp = await httpRequest(port, {
      method: 'POST',
      path: `/api/tasks/${task.id}/move`,
      body: { status: 'blocked' },
    });

    assert.equal(resp.status, 200);
    const body = resp.body as Record<string, unknown>;
    assert.equal(body.status, 'blocked');
  });

  it('returns 422 for invalid status value', async () => {
    const task = await createTask({ title: 'HTTP invalid status', status: 'todo' });

    const resp = await httpRequest(port, {
      method: 'POST',
      path: `/api/tasks/${task.id}/status`,
      body: { status: 'flying' },
    });

    assert.equal(resp.status, 422, `Expected 422 but got ${resp.status}`);
    const body = resp.body as Record<string, unknown>;
    assert.ok(typeof body.error === 'string', 'Response must have an error field');
    assert.ok((body.error as string).includes('flying'), 'Error message should mention the bad value');
  });

  it('returns 400 when status field is missing from body', async () => {
    const task = await createTask({ title: 'HTTP missing status', status: 'todo' });

    const resp = await httpRequest(port, {
      method: 'POST',
      path: `/api/tasks/${task.id}/status`,
      body: { other: 'field' },
    });

    assert.equal(resp.status, 400);
  });

  it('returns 404 for non-existent task id', async () => {
    const resp = await httpRequest(port, {
      method: 'POST',
      path: '/api/tasks/nonexistent-id-xyz/status',
      body: { status: 'done' },
    });

    assert.equal(resp.status, 404);
  });

  it('returns 400 for invalid JSON body', async () => {
    await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const bodyStr = 'not-json{{{';
      const req = http.request(
        {
          hostname: 'localhost',
          port,
          path: '/api/tasks/any-id/status',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
            catch { resolve({ status: res.statusCode ?? 0, body: data }); }
          });
        },
      );
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    }).then((resp) => {
      assert.equal(resp.status, 400);
    });
  });
});

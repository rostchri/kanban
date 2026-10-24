// WS1 feat/agent-attribution: noteMeta.agentId + Task.createdBy.agentId.
// Sanitize-Regeln, Ausrichtung, createdBy nur bei create, API/SSE-Sichtbarkeit,
// Altbestand ohne die neuen Felder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "kanban-test-agentid-"));
process.env.HOME = home;
const store = await import("../dist/storage/store.js");
const SESSION = "independent";

before(async () => {
  await store.initStorage();
});
after(() => rmSync(home, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// sanitizeAgentId (eigener Export, gleiche Regeln wie noteMeta-Felder)
// ---------------------------------------------------------------------------

test("sanitizeAgentId: valid value trimmed and accepted", () => {
  const r = store.sanitizeAgentId("  agent-abc123 ");
  assert.equal(r.agentId, "agent-abc123");
  assert.deepEqual(r.warnings, []);
  // charset wie model/agent
  assert.equal(store.sanitizeAgentId("a/b@preset+x:y[1]_z-9.W").agentId, "a/b@preset+x:y[1]_z-9.W");
});

test("sanitizeAgentId: 120 ok, 121 dropped with warning", () => {
  assert.equal(store.sanitizeAgentId("a".repeat(120)).agentId.length, 120);
  const r = store.sanitizeAgentId("a".repeat(121));
  assert.equal(r.agentId, null);
  assert.match(r.warnings[0], /agentId ignored: longer than 120/);
});

test("sanitizeAgentId: invalid charset / non-string dropped with warning", () => {
  for (const bad of ["bad agent", "agent;rm", "<b>", "agent-ä", "\u{1F600}", 42, {}]) {
    const r = store.sanitizeAgentId(bad);
    assert.equal(r.agentId, null, JSON.stringify(bad));
    assert.equal(r.warnings.length, 1);
  }
});

test("sanitizeAgentId: null/undefined/whitespace silent (fail-open, no field)", () => {
  for (const v of [undefined, null, "", "   "]) {
    const r = store.sanitizeAgentId(v);
    assert.equal(r.agentId, null);
    assert.deepEqual(r.warnings, []);
  }
});

// ---------------------------------------------------------------------------
// sanitizeNoteMeta mit agentId
// ---------------------------------------------------------------------------

test("sanitizeNoteMeta: agentId accepted alongside model/agent", () => {
  const r = store.sanitizeNoteMeta({
    model: "anthropic/claude-opus-5-5",
    agent: "my-nodejs-developer",
    agentId: "agent-xyz",
  });
  assert.deepEqual(r.meta, {
    model: "anthropic/claude-opus-5-5",
    agent: "my-nodejs-developer",
    agentId: "agent-xyz",
  });
  assert.deepEqual(r.warnings, []);
});

test("sanitizeNoteMeta: agentId-only yields meta (not null)", () => {
  assert.deepEqual(store.sanitizeNoteMeta({ agentId: "agent-1" }).meta, { agentId: "agent-1" });
});

test("sanitizeNoteMeta: invalid agentId dropped with warning, other fields survive, note never lost", () => {
  const r = store.sanitizeNoteMeta({ model: "m/1", agentId: "bad id" });
  assert.deepEqual(r.meta, { model: "m/1" });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /agentId ignored/);
  const t = store.sanitizeNoteMeta({ agentId: "x".repeat(121) });
  assert.equal(t.meta, null);
  assert.equal(t.warnings.length, 1);
});

// ---------------------------------------------------------------------------
// createTask createdBy
// ---------------------------------------------------------------------------

test("createTask with createdBy: field stored verbatim", async () => {
  const t = await store.createTask({ title: "cb-1", createdBy: { agentId: "agent-main-1" } });
  assert.deepEqual(t.createdBy, { agentId: "agent-main-1" });
  const r = await store.getTask(t.id);
  assert.deepEqual(r.createdBy, { agentId: "agent-main-1" });
});

test("createTask without createdBy: key absent (Altbestand shape)", async () => {
  const t = await store.createTask({ title: "cb-none" });
  assert.equal("createdBy" in t, false);
  assert.equal("createdBy" in (await store.getTask(t.id)), false);
});

test("updateTask never modifies createdBy", async () => {
  const t = await store.createTask({ title: "cb-upd", createdBy: { agentId: "agent-orig" } });
  const u = await store.updateTask(t.id, {
    title: "renamed",
    status: "in-progress",
    tags: ["x"],
  });
  assert.deepEqual(u.createdBy, { agentId: "agent-orig" });
  // auch ein Partikel mit createdBy-Key im Input aendert nichts (Signature verbietet es zur Compilezeit)
  const raw = await store.updateTask(t.id, { description: "d" });
  assert.deepEqual(raw.createdBy, { agentId: "agent-orig" });
  const untouched = await store.updateTask(t.id, {});
  assert.equal(untouched.title, "renamed");
  assert.deepEqual(untouched.createdBy, { agentId: "agent-orig" });
});

// ---------------------------------------------------------------------------
// appendNote agentId alignment
// ---------------------------------------------------------------------------

test("appendNote with agentId meta: index-aligned with notes", async () => {
  const t = await store.createTask({ title: "align" });
  await store.appendNote(t.id, "one");
  await store.appendNote(t.id, "two", undefined, { model: "m/2", agent: "main", agentId: "agent-2" });
  await store.appendNote(t.id, "three");
  const r = await store.getTask(t.id);
  assert.equal(r.notes.length, 3);
  assert.deepEqual(r.noteMeta, [null, { model: "m/2", agent: "main", agentId: "agent-2" }, null]);
});

// ---------------------------------------------------------------------------
// Altbestand: Task ohne createdBy/agentId laedt und bleibt erweiterbar
// ---------------------------------------------------------------------------

test("legacy tasks without createdBy/agentId load, get note appended, createdBy stays absent", async () => {
  // Aktive Session pinned: im Git-Repo-Clone detectet store sonst eine
  // git-basierte Session und readSessionData/writeFile laufen auf ein anderes Verzeichnis.
  await store.setActiveSession(SESSION);
  const dir = join(home, ".kanban", "sessions", SESSION);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "tasks.json");
  writeFileSync(file, JSON.stringify({
    version: 1, updatedAt: "2020-01-01T00:00:00Z",
    tasks: [{ id: "legacy-1", title: "old", notes: ["[2020-01-01T00:00:00Z] alt"], status: "todo", tags: [], source: "claude", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" }],
  }));
  const old = await store.getTask("legacy-1");
  assert.equal(old.createdBy, undefined);
  assert.equal(old.noteMeta, undefined);
  const r = await store.appendNote("legacy-1", "neu", undefined, { agentId: "agent-new" });
  assert.deepEqual(r.noteMeta, [null, { agentId: "agent-new" }]);
  assert.equal(r.createdBy, undefined);
});

// ---------------------------------------------------------------------------
// Sichtbarkeit: HTTP /api/tasks + SSE change events
// ---------------------------------------------------------------------------

test("HTTP /api/tasks delivers createdBy and noteMeta.agentId", async () => {
  const t = await store.createTask({ title: "api-cb", createdBy: { agentId: "agent-api" } });
  await store.appendNote(t.id, "n", undefined, { agentId: "agent-note" });
  const { createDashboardServer } = await import("../dist/server/http.js");
  const server = createDashboardServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  try {
    const { port } = server.address();
    const body = await (await fetch(`http://127.0.0.1:${port}/api/tasks`)).json();
    const task = body.tasks.find((x) => x.id === t.id);
    assert.deepEqual(task.createdBy, { agentId: "agent-api" });
    assert.deepEqual(task.noteMeta, [{ agentId: "agent-note" }]);
  } finally {
    server.close();
  }
});

test("SSE change events carry noteMeta.agentId in the task object", async () => {
  const t = await store.createTask({ title: "sse-cb", createdBy: { agentId: "agent-sse-cb" } });
  const p = nextEvent((e) => e.taskId === t.id && e.type === "updated");
  await store.appendNote(t.id, "sse", undefined, { agentId: "agent-sse" });
  const ev = await p;
  assert.deepEqual(ev.task.noteMeta, [{ agentId: "agent-sse" }]);
  assert.deepEqual(ev.task.createdBy, { agentId: "agent-sse-cb" });
});

function nextEvent(pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { store.storeEvents.off("change", h); reject(new Error("timeout waiting for event")); }, ms);
    const h = (ev) => { if (pred(ev)) { clearTimeout(t); store.storeEvents.off("change", h); resolve(ev); } };
    store.storeEvents.on("change", h);
  });
}

test("created event carries createdBy", async () => {
  const p = nextEvent((e) => e.type === "created" && e.task?.createdBy?.agentId === "agent-created-ev");
  await store.createTask({ title: "cb-event", createdBy: { agentId: "agent-created-ev" } });
  const ev = await p;
  assert.deepEqual(ev.task.createdBy, { agentId: "agent-created-ev" });
});

// ---------------------------------------------------------------------------
// MCP-Schema: neue Parameter sichtbar
// ---------------------------------------------------------------------------

test("MCP tool schema exposes createdBy_agent_id and agentId", async () => {
  // direkter Weg ueber MCP-e2e (stdio) wie in note-attribution.test.mjs.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/cli/commands.js"), "mcp"],
    env: { ...process.env, HOME: home },
  });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    const create = tools.find((x) => x.name === "task_create");
    assert.ok(create.inputSchema.properties.createdBy_agent_id, "task_create.createdBy_agent_id missing");
    const note = tools.find((x) => x.name === "task_append_note");
    assert.ok(note.inputSchema.properties.agentId, "task_append_note.agentId missing");

    // e2e: create with createdBy_agent_id -> stored; invalid -> warning, task still created
    const good = await client.callTool({
      name: "task_create",
      arguments: { title: "mcp-cb", createdBy_agent_id: "agent-mcp" },
    });
    const text = good.content[0].text;
    const id = text.match(/id=(\S+) \|/)[1];
    const task = await store.getTask(id);
    assert.deepEqual(task.createdBy, { agentId: "agent-mcp" });

    const bad = await client.callTool({
      name: "task_create",
      arguments: { title: "mcp-cb-bad", createdBy_agent_id: "bad id" },
    });
    assert.equal(bad.isError, undefined);
    assert.match(bad.content[0].text, /Warning: agentId ignored/);
    const badId = bad.content[0].text.match(/id=(\S+) \|/)[1];
    assert.equal((await store.getTask(badId)).createdBy, undefined);

    // e2e: append_note with agentId -> noteMeta.agentId; invalid -> note survives with warning
    const r = await client.callTool({
      name: "task_append_note",
      arguments: { id, note: "n", model: "m/1", agent: "main", agentId: "agent-note-mcp" },
    });
    assert.equal(r.isError, undefined);
    assert.deepEqual((await store.getTask(id)).noteMeta, [{ model: "m/1", agent: "main", agentId: "agent-note-mcp" }]);

    const r2 = await client.callTool({
      name: "task_append_note",
      arguments: { id, note: "legacy-shape", agentId: "not allowed!" },
    });
    assert.match(r2.content[0].text, /Warning: agentId ignored/);
    const t2 = await store.getTask(id);
    assert.equal(t2.notes.length, 2);
    assert.deepEqual(t2.noteMeta, [{ model: "m/1", agent: "main", agentId: "agent-note-mcp" }, null]);

    // task_update andert createdBy nie
    await client.callTool({ name: "task_update", arguments: { id, title: "renamed by mcp" } });
    assert.deepEqual((await store.getTask(id)).createdBy, { agentId: "agent-mcp" });
  } finally {
    await client.close();
  }
});

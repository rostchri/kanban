// Tests laufen gegen dist/ (npm run build:server); HOME wird auf ein Temp-Dir
// umgebogen, bevor store.js geladen wird (KANBAN_DIR = ~/.kanban).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "kanban-test-"));
process.env.HOME = home;
const store = await import("../dist/storage/store.js");
const SESSION = "independent";

before(async () => {
  await store.initStorage();
});
after(() => rmSync(home, { recursive: true, force: true }));

test("sanitizeNoteMeta: valid values pass, trimmed", () => {
  const r = store.sanitizeNoteMeta({
    model: "  openrouter/or-glm-5.3-mistral ",
    agent: "my-svelte-developer",
  });
  assert.deepEqual(r.meta, {
    model: "openrouter/or-glm-5.3-mistral",
    agent: "my-svelte-developer",
  });
  assert.deepEqual(r.warnings, []);
});

test("sanitizeNoteMeta: charset incl. [ ] @ + : accepted", () => {
  const r = store.sanitizeNoteMeta({ model: "a/b@preset/x+y:1.2[3]_z-9" });
  assert.equal(r.meta.model, "a/b@preset/x+y:1.2[3]_z-9");
});

test("sanitizeNoteMeta: invalid chars / too long / non-string dropped with warning", () => {
  const r = store.sanitizeNoteMeta({
    model: "bad model; rm -rf",
    agent: "x".repeat(121),
  });
  assert.equal(r.meta, null);
  assert.equal(r.warnings.length, 2);
  assert.equal(store.sanitizeNoteMeta({ model: 42 }).warnings.length, 1);
  assert.equal(store.sanitizeNoteMeta({ model: "<b>x</b>" }).meta, null);
});

test("sanitizeNoteMeta: 120 chars ok, empty/undefined -> null without warning", () => {
  assert.equal(store.sanitizeNoteMeta({ model: "x".repeat(120) }).meta.model.length, 120);
  assert.deepEqual(store.sanitizeNoteMeta({ model: "  " }), { meta: null, warnings: [] });
  assert.deepEqual(store.sanitizeNoteMeta(undefined), { meta: null, warnings: [] });
});

test("appendNote without meta: legacy shape, no noteMeta key", async () => {
  const t = await store.createTask({ title: "legacy" });
  const r = await store.appendNote(t.id, "plain");
  assert.equal(r.notes.length, 1);
  assert.equal(r.noteMeta, undefined);
});

test("appendNote with meta: stored index-aligned, legacy notes -> null", async () => {
  const t = await store.createTask({ title: "mixed" });
  await store.appendNote(t.id, "one");
  await store.appendNote(t.id, "two", undefined, { model: "anthropic/claude-sonnet-5-5", agent: "main" });
  await store.appendNote(t.id, "three");
  const r = await store.getTask(t.id);
  assert.equal(r.notes.length, 3);
  assert.deepEqual(r.noteMeta, [null, { model: "anthropic/claude-sonnet-5-5", agent: "main" }, null]);
  assert.match(r.notes[1], /^\[.+\] two$/);
});

test("persistence: reload from disk keeps noteMeta; old file without noteMeta loads", async () => {
  const t = await store.createTask({ title: "persist" });
  await store.appendNote(t.id, "x", undefined, { model: "m/1" });
  const data = await store.getAllData(SESSION);
  const raw = data.tasks.find((x) => x.id === t.id);
  assert.deepEqual(raw.noteMeta, [{ model: "m/1" }]);

  // alte Datei (ohne noteMeta) laden und erweitern
  const file = join(home, ".kanban", "sessions", SESSION, "tasks.json");
  writeFileSync(file, JSON.stringify({
    version: 1, updatedAt: "2020-01-01T00:00:00Z",
    tasks: [{ id: "old-1", title: "old", notes: ["[2020-01-01T00:00:00Z] alt"], status: "todo", tags: [], source: "claude", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" }],
  }));
  const old = await store.getTask("old-1");
  assert.equal(old.noteMeta, undefined);
  const r = await store.appendNote("old-1", "neu", undefined, { agent: "main" });
  assert.deepEqual(r.noteMeta, [null, { agent: "main" }]);
  assert.equal(r.notes.length, 2);
});

test("HTTP /api/tasks delivers noteMeta", async () => {
  const t = await store.createTask({ title: "api" });
  await store.appendNote(t.id, "n", undefined, { model: "m/api" });
  const { createDashboardServer } = await import("../dist/server/http.js");
  const server = createDashboardServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  try {
    const { port } = server.address();
    const body = await (await fetch(`http://127.0.0.1:${port}/api/tasks`)).json();
    const task = body.tasks.find((x) => x.id === t.id);
    assert.deepEqual(task.noteMeta, [{ model: "m/api" }]);
    assert.equal(typeof task.notes[0], "string");
  } finally {
    server.close();
  }
});

test("MCP e2e (stdio): append_note model/agent, warnings, unknown params tolerated", async () => {
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
    const ap = tools.find((t) => t.name === "task_append_note");
    assert.ok(ap.inputSchema.properties.model && ap.inputSchema.properties.agent);
    assert.deepEqual(ap.inputSchema.required, ["id", "note"]);
    for (const n of ["task_create", "task_update"]) {
      assert.notEqual(tools.find((t) => t.name === n).inputSchema.additionalProperties, false);
    }
    const text = (r) => r.content[0].text;
    // unknown param on task_create (z.B. spaeterer Hook-Zusatz) wird toleriert
    const created = await client.callTool({ name: "task_create", arguments: { title: "e2e", bogus: 1 } });
    assert.ok(!created.isError);
    const id = (text(created).match(/id=([^\s|]+)/) ?? text(created).match(/\(([^)]+)\)/))[1];
    const upd = await client.callTool({ name: "task_update", arguments: { id, status: "in-progress", bogus: "x" } });
    assert.ok(!upd.isError);

    const ok = await client.callTool({ name: "task_append_note", arguments: { id, note: "hi", model: "anthropic/claude-sonnet-5-5", agent: "main" } });
    assert.ok(!ok.isError);
    assert.doesNotMatch(text(ok), /Warning/);
    const bad = await client.callTool({ name: "task_append_note", arguments: { id, note: "bad", model: "no spaces!" } });
    assert.ok(!bad.isError);
    assert.match(text(bad), /Warning: model ignored/);
    const legacy = await client.callTool({ name: "task_append_note", arguments: { id, note: "legacy" } });
    assert.ok(!legacy.isError);

    const got = text(await client.callTool({ name: "task_get", arguments: { id } }));
    assert.match(got, /Notes \(3\):/);
    assert.match(got, /\] hi\n/);
    assert.match(got, /Note attribution[^\n]*\n  #1 model=anthropic\/claude-sonnet-5-5 agent=main/);
    assert.doesNotMatch(got, /#2/);
  } finally {
    await client.close();
  }
});

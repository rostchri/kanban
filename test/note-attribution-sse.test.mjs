// SSE/Events: noteMeta muss in Change-Events (in-process, HTTP /api/events, Polling) enthalten sein.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "kanban-test-sse-"));
process.env.HOME = home;
const store = await import("../dist/storage/store.js");
const SESSION = "independent";
const file = () => join(home, ".kanban", "sessions", SESSION, "tasks.json");

before(async () => {
  await store.initStorage();
});
after(() => rmSync(home, { recursive: true, force: true }));

function nextEvent(pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { store.storeEvents.off("change", h); reject(new Error("timeout waiting for event")); }, ms);
    const h = (ev) => { if (pred(ev)) { clearTimeout(t); store.storeEvents.off("change", h); resolve(ev); } };
    store.storeEvents.on("change", h);
  });
}

test("appendNote with meta emits 'updated' event carrying full task incl. noteMeta", async () => {
  const t = await store.createTask({ title: "sse-inproc" });
  const p = nextEvent((e) => e.taskId === t.id && e.type === "updated");
  await store.appendNote(t.id, "hello", undefined, { model: "anthropic/claude-sonnet-5-5", agent: "main" });
  const ev = await p;
  assert.deepEqual(ev.task.noteMeta, [{ model: "anthropic/claude-sonnet-5-5", agent: "main" }]);
  assert.equal(ev.task.notes.length, 1);
});

test("appendNote without meta still emits 'updated' (no noteMeta key)", async () => {
  const t = await store.createTask({ title: "sse-nometa" });
  const p = nextEvent((e) => e.taskId === t.id && e.type === "updated");
  await store.appendNote(t.id, "plain");
  const ev = await p;
  assert.equal(ev.task.noteMeta, undefined);
});

test("HTTP /api/events stream delivers noteMeta in change event", async () => {
  const { createDashboardServer } = await import("../dist/server/http.js");
  const server = createDashboardServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const ac = new AbortController();
  try {
    const t = await store.createTask({ title: "sse-http" });
    const { port } = server.address();
    const resp = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ac.signal });
    assert.equal(resp.status, 200);
    const reader = resp.body.getReader();
    // appendNote leicht verzoegert, damit der Listener sicher haengt
    setTimeout(() => store.appendNote(t.id, "via-sse", undefined, { model: "m/sse" }), 200);
    let buf = "";
    const dec = new TextDecoder();
    const deadline = Date.now() + 5000;
    let found = null;
    while (!found && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      for (const block of buf.split("\n\n")) {
        const m = block.match(/^event: change\ndata: (.+)$/m);
        if (m) {
          const ev = JSON.parse(m[1]);
          if (ev.taskId === t.id && ev.task?.noteMeta) found = ev;
        }
      }
    }
    assert.ok(found, "no change event with noteMeta received");
    assert.deepEqual(found.task.noteMeta, [{ model: "m/sse" }]);
  } finally {
    ac.abort();
    server.closeAllConnections?.();
    server.close();
  }
});

test("cross-process polling path (file changed externally) emits event with noteMeta", async () => {
  const t = await store.createTask({ title: "sse-poll" });
  store._testOverrideSessionsDir(join(home, ".kanban", "sessions"));
  await store.watchStore(); // initialer Snapshot
  const p = nextEvent((e) => e.taskId === t.id && e.type === "updated", 8000);
  const data = JSON.parse(readFileSync(file(), "utf-8"));
  const task = data.tasks.find((x) => x.id === t.id);
  task.notes = [`[${new Date().toISOString()}] extern`];
  task.noteMeta = [{ model: "m/poll", agent: "main" }];
  task.updatedAt = new Date(Date.now() + 1000).toISOString();
  writeFileSync(file(), JSON.stringify(data));
  const ev = await p;
  assert.deepEqual(ev.task.noteMeta, [{ model: "m/poll", agent: "main" }]);
  store._testResetPollState();
});

test("Regression realtime-sse: DELETE /api/tasks/:id, archive status, task_list limit/offset unaffected", async () => {
  const { createDashboardServer } = await import("../dist/server/http.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await store.createTask({ title: `reg-${i}` })).id);
  await store.appendNote(ids[0], "n", undefined, { model: "m/x" });

  // DELETE + SSE 'deleted'
  const server = createDashboardServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  try {
    const { port } = server.address();
    const p = nextEvent((e) => e.taskId === ids[3] && e.type === "deleted");
    const r = await fetch(`http://127.0.0.1:${port}/api/tasks/${ids[3]}`, { method: "DELETE" });
    assert.equal(r.status, 200);
    await p;
    assert.equal(await store.getTask(ids[3]), undefined);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }

  // MCP: archive + task_list limit/offset + default open-only
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/cli/commands.js"), "mcp"],
    env: { ...process.env, HOME: home },
  }));
  try {
    const up = await client.callTool({ name: "task_update", arguments: { id: ids[1], status: "archive" } });
    assert.ok(!up.isError, up.content[0].text);
    assert.equal((await store.getTask(ids[1])).status, "archive");
    const all = (await client.callTool({ name: "task_list", arguments: {} })).content[0].text;
    assert.ok(!all.includes(ids[1]), "archived task must not be in default task_list");
    assert.ok(all.includes(ids[0]));
    const lim = (await client.callTool({ name: "task_list", arguments: { limit: 1 } })).content[0].text;
    assert.equal((lim.match(/^\[[a-z-]+\] /gm) ?? []).length, 1);
  } finally {
    await client.close();
  }
});

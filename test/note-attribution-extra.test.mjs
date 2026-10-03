// Testmanager-Runde 1: Zusatzfaelle fuer noteMeta (Ausrichtung, Grenzwerte, CLI, Update/Delete).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const home = mkdtempSync(join(tmpdir(), "kanban-test-extra-"));
process.env.HOME = home;
const store = await import("../dist/storage/store.js");
const SESSION = "independent";
const file = () => join(home, ".kanban", "sessions", SESSION, "tasks.json");

before(async () => {
  await store.initStorage();
});
after(() => rmSync(home, { recursive: true, force: true }));

test("sanitizeNoteMeta: boundary 120 ok / 121 dropped; trim happens before length check", () => {
  assert.equal(store.sanitizeNoteMeta({ model: "a".repeat(120) }).meta.model.length, 120);
  const r = store.sanitizeNoteMeta({ model: "a".repeat(121) });
  assert.equal(r.meta, null);
  assert.match(r.warnings[0], /model ignored: longer than 120/);
  // 120 Zeichen + Whitespace aussen -> nach trim gueltig
  assert.equal(store.sanitizeNoteMeta({ agent: `  ${"a".repeat(120)}\n` }).meta.agent.length, 120);
});

test("sanitizeNoteMeta: whitespace-only silently ignored, inner whitespace/newline/tab rejected", () => {
  assert.deepEqual(store.sanitizeNoteMeta({ model: " \t\n ", agent: "" }), { meta: null, warnings: [] });
  for (const bad of ["a b", "a\nb", "a\tb"]) {
    const r = store.sanitizeNoteMeta({ model: bad });
    assert.equal(r.meta, null, JSON.stringify(bad));
    assert.equal(r.warnings.length, 1);
  }
});

test("sanitizeNoteMeta: Unicode / emoji / control chars / injection rejected", () => {
  for (const bad of ["modell-ä", "\u{1F600}", "\u0000", "a​b", "x‮y", "<script>", "a;b", "a\"b", "a`b", "$(id)", "a\\b", "a#b", "a*b"]) {
    const r = store.sanitizeNoteMeta({ model: bad });
    assert.equal(r.meta, null, JSON.stringify(bad));
    assert.equal(r.warnings.length, 1, JSON.stringify(bad));
  }
  // Emoji-Laenge: 61 Emojis = 122 UTF-16 units -> trotzdem nur Charset-Warnung, kein Crash
  assert.equal(store.sanitizeNoteMeta({ model: "\u{1F600}".repeat(61) }).meta, null);
});

test("sanitizeNoteMeta: non-string types (object/array/bool/number) warn; null/undefined silent", () => {
  for (const v of [{}, [], true, 0, 1.5]) {
    const r = store.sanitizeNoteMeta({ model: v });
    assert.equal(r.meta, null);
    assert.match(r.warnings[0], /must be a string/);
  }
  assert.deepEqual(store.sanitizeNoteMeta({ model: null, agent: undefined }), { meta: null, warnings: [] });
  assert.deepEqual(store.sanitizeNoteMeta({}), { meta: null, warnings: [] });
  assert.deepEqual(store.sanitizeNoteMeta(null), { meta: null, warnings: [] });
});

test("sanitizeNoteMeta: only agent / only model / one valid + one invalid", () => {
  assert.deepEqual(store.sanitizeNoteMeta({ agent: "main" }).meta, { agent: "main" });
  assert.deepEqual(store.sanitizeNoteMeta({ model: "m/1" }).meta, { model: "m/1" });
  const r = store.sanitizeNoteMeta({ model: "m/1", agent: "bad agent" });
  assert.deepEqual(r.meta, { model: "m/1" });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^agent ignored/);
  // unbekannte Felder werden nicht uebernommen
  assert.deepEqual(store.sanitizeNoteMeta({ model: "m", extra: "x" }).meta, { model: "m" });
});

test("sanitizeNoteMeta: prototype-pollution-artige Keys haben keinen Effekt", () => {
  const r = store.sanitizeNoteMeta(JSON.parse('{"__proto__":{"model":"evil"},"model":"ok"}'));
  assert.deepEqual(r.meta, { model: "ok" });
  assert.equal(({}).model, undefined);
});

test("appendNote: meta first, then plain notes -> padded with null, aligned", async () => {
  const t = await store.createTask({ title: "meta-first" });
  await store.appendNote(t.id, "a", undefined, { model: "m/1" });
  await store.appendNote(t.id, "b");
  await store.appendNote(t.id, "c", undefined, { agent: "x" });
  await store.appendNote(t.id, "d", undefined, null);
  const r = await store.getTask(t.id);
  assert.equal(r.notes.length, 4);
  assert.deepEqual(r.noteMeta, [{ model: "m/1" }, null, { agent: "x" }, null]);
});

test("appendNote: agent only and model only stored without the other key", async () => {
  const t = await store.createTask({ title: "partial" });
  await store.appendNote(t.id, "a", undefined, { agent: "main" });
  await store.appendNote(t.id, "b", undefined, { model: "m/2" });
  const r = await store.getTask(t.id);
  assert.deepEqual(r.noteMeta, [{ agent: "main" }, { model: "m/2" }]);
  assert.ok(!("model" in r.noteMeta[0]) && !("agent" in r.noteMeta[1]));
});

test("appendNote: empty meta object {} is stored as {} (not null) - documents current behaviour", async () => {
  const t = await store.createTask({ title: "emptyobj" });
  const r = await store.appendNote(t.id, "a", undefined, {});
  // {} ist truthy -> wird als {} gespeichert; sanitizeNoteMeta liefert nie {}, nur direkter API-Aufruf
  assert.deepEqual(r.noteMeta, [{}]);
});

test("appendNote: short / stale noteMeta in file is re-aligned (shorter -> null padding, longer -> truncated)", async () => {
  const mk = (id, notes, noteMeta) => ({ id, title: id, notes, noteMeta, status: "todo", tags: [], source: "claude", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" });
  writeFileSync(file(), JSON.stringify({
    version: 1, updatedAt: "2020-01-01T00:00:00Z",
    tasks: [
      mk("short", ["n1", "n2", "n3"], [{ model: "m/1" }]),
      mk("long", ["n1"], [{ model: "m/1" }, { model: "stale" }, { model: "stale2" }]),
      mk("allnull", ["n1"], [null]),
    ],
  }));
  const s = await store.appendNote("short", "n4", undefined, { agent: "a" });
  assert.deepEqual(s.noteMeta, [{ model: "m/1" }, null, null, { agent: "a" }]);
  assert.equal(s.noteMeta.length, s.notes.length);
  const l = await store.appendNote("long", "n2", undefined, { agent: "a" });
  assert.equal(l.noteMeta.length, l.notes.length);
  assert.deepEqual(l.noteMeta, [{ model: "m/1" }, { agent: "a" }]);
  // noteMeta=[null] (existiert, Laenge>0) bleibt auch bei Note ohne Meta ausgerichtet
  const n = await store.appendNote("allnull", "n2");
  assert.deepEqual(n.noteMeta, [null, null]);
});

test("updateTask/moveTask keep notes+noteMeta untouched and aligned", async () => {
  const t = await store.createTask({ title: "upd" });
  await store.appendNote(t.id, "a", undefined, { model: "m/1" });
  await store.appendNote(t.id, "b");
  await store.updateTask(t.id, { title: "upd2", description: "d", tags: ["x"], status: "in-progress" });
  await store.moveTask(t.id, "done");
  const r = await store.getTask(t.id);
  assert.equal(r.status, "done");
  assert.equal(r.notes.length, 2);
  assert.deepEqual(r.noteMeta, [{ model: "m/1" }, null]);
  // weitere Note nach Update bleibt aligned
  const r2 = await store.appendNote(t.id, "c", undefined, { agent: "z" });
  assert.deepEqual(r2.noteMeta, [{ model: "m/1" }, null, { agent: "z" }]);
});

test("updateTask: noteMeta/notes in input are NOT writable via update (type-escape attempt)", async () => {
  const t = await store.createTask({ title: "noescape" });
  await store.appendNote(t.id, "a", undefined, { model: "m/1" });
  await store.updateTask(t.id, { noteMeta: [{ model: "forged" }], notes: [] });
  const r = await store.getTask(t.id);
  assert.deepEqual(r.noteMeta, [{ model: "m/1" }]);
  assert.equal(r.notes.length, 1);
});

test("deleteTask removes task with its noteMeta; other tasks' noteMeta unaffected", async () => {
  const a = await store.createTask({ title: "del-a" });
  const b = await store.createTask({ title: "del-b" });
  await store.appendNote(a.id, "x", undefined, { model: "m/a" });
  await store.appendNote(b.id, "y", undefined, { model: "m/b" });
  assert.equal(await store.deleteTask(a.id), true);
  assert.equal(await store.getTask(a.id), undefined);
  assert.deepEqual((await store.getTask(b.id)).noteMeta, [{ model: "m/b" }]);
  const raw = (await store.getAllData(SESSION)).tasks;
  assert.ok(!raw.some((x) => x.id === a.id));
});

test("appendNote on unknown id returns undefined and does not touch other tasks", async () => {
  const t = await store.createTask({ title: "other" });
  await store.appendNote(t.id, "x", undefined, { model: "m/1" });
  assert.equal(await store.appendNote("does-not-exist", "n", undefined, { model: "m/2" }), undefined);
  assert.deepEqual((await store.getTask(t.id)).noteMeta, [{ model: "m/1" }]);
});

test("concurrent appendNote (sequentially awaited bursts) keep notes/noteMeta length equal", async () => {
  const t = await store.createTask({ title: "burst" });
  for (let i = 0; i < 10; i++) {
    await store.appendNote(t.id, `n${i}`, undefined, i % 2 ? { model: `m/${i}` } : undefined);
  }
  const r = await store.getTask(t.id);
  assert.equal(r.notes.length, 10);
  assert.equal(r.noteMeta.length, 10);
  assert.equal(r.noteMeta[1].model, "m/1");
  assert.equal(r.noteMeta[0], null);
});

test("recallTasks/listTasks still return noteMeta-bearing tasks (search over notes unaffected)", async () => {
  const t = await store.createTask({ title: "recall-me" });
  await store.appendNote(t.id, "uniqueword", undefined, { model: "m/r" });
  const list = await store.listTasks();
  assert.deepEqual(list.find((x) => x.id === t.id).noteMeta, [{ model: "m/r" }]);
  // recallTasks bewertet Notes weiterhin (Titel+Notes-Keywords) und blaeht Notes nicht um Meta auf
  const t2 = await store.createTask({ title: "recall-me uniqueword", description: "uniqueword recall-me" });
  await store.appendNote(t2.id, "uniqueword recall-me", undefined, { model: "m/zzz-meta" });
  const rec = await store.recallTasks("recall-me uniqueword");
  assert.ok(rec.relevant.some((x) => x.id === t2.id));
  assert.ok(!(await store.getTask(t2.id)).notes.join(" ").includes("m/zzz-meta"));
});

const cli = (...args) =>
  execFileSync(process.execPath, [join(process.cwd(), "dist/cli/commands.js"), ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

test("CLI: kb note --model/--agent stores meta; invalid value warns on stderr, note kept", async () => {
  const t = await store.createTask({ title: "cli" });
  cli("note", t.id, "hello", "--model", "anthropic/claude-sonnet-5-5", "--agent", "main");
  cli("note", t.id, "plain");
  let stderr = "";
  try {
    execFileSync(process.execPath, [join(process.cwd(), "dist/cli/commands.js"), "note", t.id, "bad", "--model", "no spaces"], {
      env: { ...process.env, HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) { stderr = e.stderr; throw e; }
  const r = await store.getTask(t.id);
  assert.equal(r.notes.length, 3);
  assert.deepEqual(r.noteMeta, [{ model: "anthropic/claude-sonnet-5-5", agent: "main" }, null, null]);
  void stderr;
});

test("CLI: invalid --model prints Warning on stderr", async () => {
  const t = await store.createTask({ title: "cli-warn" });
  const { spawnSync } = await import("node:child_process");
  const p = spawnSync(process.execPath, [join(process.cwd(), "dist/cli/commands.js"), "note", t.id, "x", "--model", "bad model"], {
    env: { ...process.env, HOME: home }, encoding: "utf8",
  });
  assert.equal(p.status, 0);
  assert.match(p.stderr, /Warning: model ignored/);
  const r = await store.getTask(t.id);
  assert.equal(r.notes.length, 1);
  assert.equal(r.noteMeta, undefined);
});

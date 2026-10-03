#!/usr/bin/env node
import { createRequire } from "module";
import { Command } from "commander";
import { startDashboardServer } from "../server/http.js";

const { version } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};
import { startMcpServer } from "../mcp/server.js";
import {
  initStorage,
  createTask,
  listTasks,
  moveTask,
  deleteTask,
  getTask,
  appendNote,
  sanitizeNoteMeta,
  recallTasks,
  getAllData,
  listAllSessions,
  getCurrentSessionName,
  setActiveSession,
  detectLatestSession,
} from "../storage/store.js";
import { VALID_STATUSES } from "../types.js";
import open from "open";

const program = new Command();

program
  .name("kanban")
  .description(
    "Minimal Kanban task tracking for AI agents (Claude Code, OpenCode)",
  )
  .version(version);

// Default: start dashboard
program
  .command("dashboard", { isDefault: true })
  .description("Start the Kanban dashboard server")
  .option("-p, --port <number>", "Port to run on", "3456")
  .option("--no-open", "Do not open browser automatically")
  .action(async (options) => {
    await initStorage();
    const port = parseInt(options.port, 10);
    console.log("Starting CWIM Kanban dashboard...");
    const session = await detectLatestSession();
    const currentSession = await getCurrentSessionName();
    if (session) {
      console.log(`Detected session: ${session.name}`);
      console.log(`Active session: ${currentSession}`);
    } else {
      console.log("Running in Independent Mode");
    }
    await startDashboardServer(port);
    if (options.open !== false) {
      await open(`http://localhost:${port}`);
    }
  });

// MCP server mode
program
  .command("mcp")
  .description("Start the MCP server (for Claude Code or OpenCode integration)")
  .action(async () => {
    await initStorage();
    await startMcpServer();
  });

// Initialize storage
program
  .command("init")
  .description("Initialize CWIM Kanban storage directory")
  .action(async () => {
    await initStorage();
    console.log("CWIM Kanban initialized at ~/.kanban/");
  });

// Sessions management
program
  .command("sessions")
  .description("List all available sessions")
  .action(async () => {
    await initStorage();
    const sessions = await listAllSessions();
    const active = await getCurrentSessionName();

    if (sessions.length === 0) {
      console.log("No sessions found");
      return;
    }

    console.log(`Active session: ${active}\n`);
    console.log("Available sessions:");
    for (const session of sessions) {
      const marker = session.name === active ? " *" : "";
      console.log(`  - ${session.name}${marker}`);
    }
  });

program
  .command("switch <name>")
  .description("Switch to a different session")
  .action(async (name) => {
    await initStorage();
    const sessions = await listAllSessions();
    const exists = sessions.some((s) => s.name === name);
    if (!exists) {
      console.error(
        `Session "${name}" not found. Use 'kanban sessions' to list available sessions.`,
      );
      process.exit(1);
    }
    await setActiveSession(name);
    console.log(`Switched to session: ${name}`);
  });

// Add task
program
  .command("add <title>")
  .description("Add a new task to the current session")
  .option("-d, --description <desc>", "Task description")
  .option("-s, --status <status>", "Initial status", "todo")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .action(async (title, options) => {
    await initStorage();
    const status = VALID_STATUSES.includes(options.status)
      ? options.status
      : "todo";
    const tags = options.tags
      ? options.tags
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean)
      : [];
    const task = await createTask({
      title,
      description: options.description,
      status,
      tags,
      source: "manual",
    });
    const sessionName = await getCurrentSessionName();
    console.log(
      `Created: [${task.status}] ${task.title} (${task.id}) [Session: ${sessionName}]`,
    );
  });

// List tasks
program
  .command("list")
  .description("List all tasks in the current session")
  .option("-s, --status <status>", "Filter by status")
  .option("-t, --tag <tag>", "Filter by tag")
  .option("-q, --query <query>", "Search query for title/description")
  .action(async (options) => {
    await initStorage();
    const sessionName = await getCurrentSessionName();
    const tasks = await listTasks(undefined, {
      status: VALID_STATUSES.includes(options.status)
        ? options.status
        : undefined,
      tag: options.tag,
      query: options.query,
    });
    if (tasks.length === 0) {
      console.log(`No tasks found in session "${sessionName}"`);
      return;
    }
    const data = await getAllData();
    console.log(
      `Session: ${data.session?.name ?? "Independent"} | Total: ${data.tasks.length} tasks`,
    );
    console.log("");
    for (const t of tasks) {
      const tags = t.tags.length > 0 ? ` #${t.tags.join(" #")}` : "";
      const desc = t.description ? `\n  ${t.description}` : "";
      console.log(`[${t.status}] ${t.title} (${t.id})${tags}${desc}`);
    }
  });

// Mark task as done
program
  .command("done <id>")
  .description("Mark a task as done")
  .action(async (id) => {
    await initStorage();
    const task = await moveTask(id, "done");
    if (task) {
      console.log(`Done: ${task.title}`);
    } else {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }
  });

// Move task to any status
program
  .command("move <id> <status>")
  .description("Move a task to a different status")
  .action(async (id, status) => {
    await initStorage();
    if (!VALID_STATUSES.includes(status)) {
      console.error(`Invalid status. Valid: ${VALID_STATUSES.join(", ")}`);
      process.exit(1);
    }
    const task = await moveTask(id, status as any);
    if (task) {
      console.log(`Moved: ${task.title} -> ${task.status}`);
    } else {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }
  });

// Delete task
program
  .command("remove <id>")
  .description("Delete a task")
  .action(async (id) => {
    await initStorage();
    const ok = await deleteTask(id);
    if (ok) {
      console.log(`Deleted: ${id}`);
    } else {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }
  });

// Append note to task
program
  .command("note <id> <text>")
  .description("Append a note to a task")
  .option("--model <model>", "Attribute note to a model")
  .option("--agent <agent>", "Attribute note to an agent")
  .action(async (id, text, opts) => {
    await initStorage();
    const { meta, warnings } = sanitizeNoteMeta(opts);
    for (const w of warnings) console.error(`Warning: ${w}`);
    const task = await appendNote(id, text, undefined, meta);
    if (task) {
      const noteCount = task.notes?.length ?? 0;
      console.log(`Note appended to: ${task.title}`);
      console.log(`Total notes: ${noteCount}`);
    } else {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }
  });

// Recall relevant tasks
program
  .command("recall [context]")
  .description("Recall relevant tasks based on context")
  .option("-l, --limit <number>", "Max number of tasks to return", "5")
  .action(async (context, options) => {
    await initStorage();
    const limit = parseInt(options.limit, 10) || 5;
    const result = await recallTasks(context || "", limit);
    const sessionName = await getCurrentSessionName();

    console.log(`Session: ${sessionName}`);
    console.log(
      `Summary: ${result.summary.active} active, ${result.summary.done} done, ${result.summary.blocked} blocked (total: ${result.summary.total})`,
    );
    console.log("");

    if (result.relevant.length === 0) {
      console.log("No relevant tasks found.");
      return;
    }

    console.log(`Relevant tasks (${result.relevant.length}):`);
    for (const t of result.relevant) {
      const notesPreview =
        t.notes && t.notes.length > 0 ? ` [${t.notes.length} notes]` : "";
      console.log(`• [${t.status}] ${t.title} (${t.id})${notesPreview}`);
    }
  });

// Show task details
program
  .command("show <id>")
  .description("Show task details")
  .action(async (id) => {
    await initStorage();
    const task = await getTask(id);
    if (!task) {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }
    const sessionName = await getCurrentSessionName();
    console.log(`Title:       ${task.title}`);
    console.log(`ID:          ${task.id}`);
    console.log(`Status:      ${task.status}`);
    console.log(`Description: ${task.description ?? "(none)"}`);
    if (task.notes && task.notes.length > 0) {
      console.log(`Notes (${task.notes.length}):`);
      for (const note of task.notes) {
        console.log(`  ${note}`);
      }
    }
    console.log(`Tags:        ${task.tags.join(", ") || "(none)"}`);
    console.log(`Source:      ${task.source}`);
    console.log(`Session:     ${sessionName}`);
    console.log(`Created:     ${task.createdAt}`);
    console.log(`Updated:     ${task.updatedAt}`);
  });

// Status overview
program
  .command("status")
  .description("Show board overview")
  .action(async () => {
    await initStorage();
    const data = await getAllData();
    const byStatus = {
      todo: data.tasks.filter((t) => t.status === "todo").length,
      "in-progress": data.tasks.filter((t) => t.status === "in-progress")
        .length,
      done: data.tasks.filter((t) => t.status === "done").length,
      blocked: data.tasks.filter((t) => t.status === "blocked").length,
    };
    console.log(`Session: ${data.session?.name ?? "Independent"}`);
    console.log("");
    console.log(`To Do:       ${byStatus.todo}`);
    console.log(`In Progress: ${byStatus["in-progress"]}`);
    console.log(`Done:        ${byStatus.done}`);
    console.log(`Blocked:     ${byStatus.blocked}`);
    console.log("");
    console.log(`Total: ${data.tasks.length} tasks`);
  });

// Parse CLI
program.parse();

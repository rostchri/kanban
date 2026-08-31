#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
import { execSync } from "child_process";

const { version } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  moveTask,
  deleteTask,
  appendNote,
  recallTasks,
  listAllSessions,
  getCurrentSessionName,
  setActiveSession,
} from "../storage/store.js";
import { VALID_STATUSES, type TaskStatus } from "../types.js";

/**
 * Stati, die "offene Arbeit" bedeuten — der Default von task_list.
 *
 * Warum ein Default noetig wurde: das Board waechst, und task_list lieferte
 * ausnahmslos JEDEN Task zurueck. Bei 694 Tasks waren das 126 KB (~36.000
 * Token) pro Aufruf — ein Viertel des Kontextfensters eines 147k-Modells,
 * bei kleineren Modellen mehr als das ganze. Gemessen: 82 % davon entfielen
 * auf `archive` (380) und `done` (192), also auf abgeschlossene Arbeit, die
 * ein Agent beim "was ist zu tun?" gar nicht sehen will.
 *
 * `in-progress` gehoert bewusst DAZU: wer nach offener Arbeit fragt, meint
 * auch das, was bereits laeuft — sonst sieht ein Agent seine eigenen aktiven
 * Tickets nicht und legt Duplikate an.
 */
const OPEN_STATUSES: TaskStatus[] = ["todo", "in-progress", "blocked"];

/** Obergrenze fuer eine task_list-Antwort, wenn der Aufrufer nichts vorgibt. */
const TASK_LIST_DEFAULT_LIMIT = 100;

// ---------------------------------------------------------------------------
// Tool-call artifact recovery
// ---------------------------------------------------------------------------

/**
 * Regex that detects the artifact sentinel `</description>` in a description
 * string — we require it to appear and everything from that point onward is
 * the "artifact tail" that must be trimmed.
 *
 * We deliberately do NOT try to parse the tags array inside the regex because
 * the real-world mangle format omits the closing `</parameter>`, making a
 * single capturing group unreliable.  Tag extraction is done imperatively
 * below using bracket-matching instead.
 *
 * Anchor: the sentinel must be present for the match to succeed.
 */
const ARTIFACT_SENTINEL_RE = /<\/description>/;

/**
 * Extract a JSON array from a string that starts somewhere after
 * `<parameter name="tags">`.  Handles the two known formats:
 *
 *   WITH closing tag:    `["a","b"]</parameter>`
 *   WITHOUT closing tag: `["a","b"]`  (string ends there)
 *
 * Uses simple bracket-counting rather than a regex so it is robust against
 * nested brackets in tag values.
 *
 * Returns the parsed string[] on success, or undefined on any parse error.
 */
function extractTagsFromArtifactTail(tail: string): string[] | undefined {
  // Find the opening bracket of the JSON array.
  const bracketStart = tail.indexOf("[");
  if (bracketStart === -1) {
    return undefined;
  }

  // Walk forward to find the matching closing bracket.
  let depth = 0;
  let bracketEnd = -1;
  for (let i = bracketStart; i < tail.length; i++) {
    if (tail[i] === "[") {
      depth++;
    } else if (tail[i] === "]") {
      depth--;
      if (depth === 0) {
        bracketEnd = i;
        break;
      }
    }
  }

  if (bracketEnd === -1) {
    // Unclosed bracket — try using the last `]` in the string as a fallback.
    const lastClose = tail.lastIndexOf("]");
    if (lastClose === -1) {
      return undefined;
    }
    bracketEnd = lastClose;
  }

  const candidate = tail.slice(bracketStart, bracketEnd + 1);

  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    // Malformed JSON — leave tags empty, do not crash.
    process.stderr.write(
      `[kanban-mcp] WARN: could not parse tags array from artifact tail: ${candidate}\n`,
    );
  }

  return undefined;
}

/**
 * Recover a potentially mangled `description` + `tags` pair.
 *
 * Handles the known AI tool-call bug where long descriptions bleed into the
 * next parameter — the `tags` JSON array ends up appended to the description
 * text as literal XML while `tags` arrives empty/missing.
 *
 * Two confirmed real-world formats are handled:
 *
 *   WITH closing </parameter>:
 *     `...real text</description>\n<parameter name="tags">["a","b"]</parameter>`
 *
 *   WITHOUT closing </parameter> (the common case!):
 *     `...real text</description>\n<parameter name="tags">["a","b"]`
 *
 * Behaviour:
 *  - If the description does NOT contain `</description>`: returns inputs unchanged.
 *  - If it does:
 *    - Strips everything from `</description>` onward from the description.
 *    - When `providedTags` is empty/absent: extracts the JSON array after
 *      `<parameter name="tags">` via bracket-matching (no </parameter> needed).
 *    - When `providedTags` is non-empty: caller tags take precedence, artifact
 *      tags are ignored.
 *    - Logs a warning (stderr) so operators can see recoveries in container logs.
 *
 * Conservative by design: only acts when `</description>` is present.
 */
function recoverDescriptionAndTags(
  description: string | undefined,
  providedTags: string[] | undefined,
): { description: string | undefined; tags: string[] | undefined; recovered: boolean } {
  if (!description) {
    return { description, tags: providedTags, recovered: false };
  }

  if (!ARTIFACT_SENTINEL_RE.test(description)) {
    return { description, tags: providedTags, recovered: false };
  }

  // Trim the artifact tail: everything from the first </description> onward.
  const cutIdx = description.indexOf("</description>");
  const cleanDescription = description.slice(0, cutIdx).trimEnd() || undefined;

  // Attempt to recover tags from the artifact tail if caller sent none.
  let recoveredTags: string[] | undefined = providedTags;
  const hasTags = Array.isArray(providedTags) && providedTags.length > 0;

  if (!hasTags) {
    const tail = description.slice(cutIdx); // everything from </description> onward
    // Look for <parameter name="tags"> — case-insensitive for robustness.
    const tagsParamMatch = /\bparameter\s[^>]*name\s*=\s*["']tags["'][^>]*>/i.exec(tail);
    if (tagsParamMatch) {
      const afterOpenTag = tail.slice(tagsParamMatch.index + tagsParamMatch[0].length);
      const parsed = extractTagsFromArtifactTail(afterOpenTag);
      if (parsed !== undefined) {
        recoveredTags = parsed;
      }
    }
  }

  process.stderr.write(
    `[kanban-mcp] WARN: tool-call artifact detected in description — trimmed tail and recovered tags: ${JSON.stringify(recoveredTags ?? [])}\n`,
  );

  return { description: cleanDescription, tags: recoveredTags, recovered: true };
}

// ---------------------------------------------------------------------------
// Strict status validation
// ---------------------------------------------------------------------------

/**
 * Validates that `value` is a member of VALID_STATUSES.
 *
 * Throws a descriptive Error when invalid — never silently defaults.
 * Returns the typed TaskStatus on success.
 */
function requireValidStatus(value: unknown, fieldName: string = "status"): TaskStatus {
  if (typeof value !== "string" || !(VALID_STATUSES as string[]).includes(value)) {
    throw new Error(
      `Invalid ${fieldName}: "${value}". Must be one of: ${VALID_STATUSES.join(", ")}.`,
    );
  }
  return value as TaskStatus;
}

/**
 * Like requireValidStatus but only validates when a value is present.
 * Returns undefined when value is absent (undefined/null).
 */
function validateOptionalStatus(value: unknown): TaskStatus | undefined {
  if (value === undefined || value === null) return undefined;
  return requireValidStatus(value);
}

// ---------------------------------------------------------------------------
// Agent detection
// ---------------------------------------------------------------------------

function detectAgent(): "claude" | "opencode" {
  if (process.env.CLAUDE_CODE) return "claude";
  if (process.env.OPENCODE) return "opencode";

  // Try to detect parent process name cross-platform
  if (process.ppid) {
    try {
      let parentProcess = "";

      if (process.platform === "win32") {
        // Windows: use wmic or tasklist
        try {
          parentProcess = execSync(
            `wmic process where "ProcessId=${process.ppid}" get Name /value`,
            { encoding: "utf8", timeout: 5000 },
          );
        } catch {
          // Fallback to tasklist
          parentProcess = execSync(
            `tasklist /FI "PID eq ${process.ppid}" /FO CSV /NH`,
            { encoding: "utf8", timeout: 5000 },
          );
        }
      } else {
        // Unix-like (macOS, Linux)
        parentProcess = execSync(`ps -p ${process.ppid} -o comm=`, {
          encoding: "utf8",
          timeout: 5000,
        }).trim();
      }

      if (parentProcess.toLowerCase().includes("claude")) return "claude";
      if (parentProcess.toLowerCase().includes("opencode")) return "opencode";
    } catch {
      // Ignore errors from process detection
    }
  }

  // Default fallback
  return "claude";
}

const CURRENT_AGENT = detectAgent();

const server = new Server(
  {
    name: "cwim-kanban",
    version,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "task_create",
        description:
          "Create a new task on the Kanban board. " +
          "IMPORTANT: The response includes the resulting id, status and tags — verify them to confirm the task was created correctly.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Task title (required)" },
            description: {
              type: "string",
              description: "Optional task description",
            },
            status: {
              type: "string",
              enum: VALID_STATUSES,
              description: `Initial status. Must be one of: ${VALID_STATUSES.join(", ")}. Defaults to "todo" when omitted.`,
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional tags for categorization. Pass as a JSON array, e.g. [\"bug\", \"host:srv01\"]. " +
                "Do NOT embed tags inside the description field — use this parameter.",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "task_update",
        description:
          "Update fields of an existing task. " +
          "IMPORTANT: The response includes the resulting id, status and tags — verify them to confirm the update was applied correctly.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task ID (required)" },
            title: { type: "string", description: "New title" },
            description: { type: "string", description: "New description" },
            status: {
              type: "string",
              enum: VALID_STATUSES,
              description: `New status. Must be one of: ${VALID_STATUSES.join(", ")}.`,
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Replacement tag list (replaces all existing tags)",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "task_move",
        description:
          "Move a task to a different status column. " +
          "Use the 'status' parameter (NOT 'column'). " +
          "IMPORTANT: The response includes the resulting id, status and tags — verify them.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task ID (required)" },
            status: {
              type: "string",
              enum: VALID_STATUSES,
              description: `New status (required). Must be one of: ${VALID_STATUSES.join(", ")}.`,
            },
          },
          required: ["id", "status"],
        },
      },
      {
        name: "task_delete",
        description: "Delete a task from the board",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task ID (required)" },
          },
          required: ["id"],
        },
      },
      {
        name: "task_list",
        description:
          "List OPEN tasks in the current session (todo, in-progress, blocked). " +
          "Finished work is NOT included by default: pass status:\"done\" or " +
          "status:\"archive\" to see it, or status:\"all\" for everything. " +
          "Results are capped at 100 by default — raise with limit, page with offset. " +
          "The response reports total/shown so you can tell when results were cut off.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: [...VALID_STATUSES, "all"],
              description:
                `Filter by a single status (${VALID_STATUSES.join(", ")}), or "all" for every status. ` +
                `Omitted = open work only (${OPEN_STATUSES.join(", ")}).`,
            },
            tag: {
              type: "string",
              description: "Filter by tag (exact match)",
            },
            query: {
              type: "string",
              description:
                "Search query to filter tasks by title or description (case-insensitive). " +
                "Searches ALL statuses, not just open ones — a search should find what you look for.",
            },
            limit: {
              type: "number",
              description: `Maximum tasks to return (default ${TASK_LIST_DEFAULT_LIMIT}).`,
            },
            offset: {
              type: "number",
              description: "Skip this many tasks before returning (for paging).",
            },
          },
        },
      },
      {
        name: "task_append_note",
        description:
          "Append a timestamped note to a task without overwriting existing content",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task ID (required)" },
            note: {
              type: "string",
              description: "Note text to append (required)",
            },
          },
          required: ["id", "note"],
        },
      },
      {
        name: "task_recall",
        description:
          "Intelligently recall relevant task context based on current work. Call this before starting complex tasks to check for existing context and avoid duplicating work.",
        inputSchema: {
          type: "object",
          properties: {
            context: {
              type: "string",
              description:
                'Brief description of what you are about to work on (e.g., "refactoring auth middleware")',
            },
            limit: {
              type: "number",
              description:
                "Max number of relevant tasks to return (default: 5)",
              default: 5,
            },
          },
        },
      },
      {
        name: "task_get",
        description: "Get details of a single task",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task ID (required)" },
          },
          required: ["id"],
        },
      },
      {
        name: "session_list",
        description: "List all available sessions",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "session_switch",
        description: "Switch to a different session",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Session name to switch to (required)",
            },
          },
          required: ["name"],
        },
      },
    ],
  };
});

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case "task_create": {
          if (!args.title || typeof args.title !== "string" || !args.title.trim()) {
            return {
              content: [{ type: "text", text: "Error: 'title' is required and must be a non-empty string." }],
              isError: true,
            };
          }

          // Recover mangled description / tags from tool-call artifact bleeding.
          const rawTags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
          const { description, tags, recovered } = recoverDescriptionAndTags(
            args.description ? String(args.description) : undefined,
            rawTags,
          );

          // Validate optional status — error if provided but invalid.
          const status = args.status !== undefined && args.status !== null
            ? requireValidStatus(args.status)
            : "todo";

          const task = await createTask({
            title: String(args.title).trim(),
            description,
            status,
            tags,
            source: CURRENT_AGENT,
          });
          const sessionName = await getCurrentSessionName();

          const recoveryNote = recovered
            ? "\nWARNING: Tool-call artifact detected — description was trimmed and/or tags were recovered. Please verify the values below."
            : "";

          return {
            content: [
              {
                type: "text",
                text:
                  `Created task "${task.title}" in session "${sessionName}".${recoveryNote}\n` +
                  `VERIFY: id=${task.id} | status=${task.status} | tags=${JSON.stringify(task.tags)}`,
              },
            ],
          };
        }

        case "task_update": {
          if (!args.id || typeof args.id !== "string") {
            return {
              content: [{ type: "text", text: "Error: 'id' is required." }],
              isError: true,
            };
          }

          // Recover mangled description / tags from tool-call artifact bleeding.
          const rawTags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
          const rawDesc = args.description !== undefined ? String(args.description) : undefined;
          const { description, tags, recovered } = recoverDescriptionAndTags(rawDesc, rawTags);

          // Validate optional status — error if provided but invalid.
          const status = validateOptionalStatus(args.status);

          const task = await updateTask(String(args.id), {
            title: args.title !== undefined ? String(args.title) : undefined,
            description,
            status,
            tags,
          });
          if (!task) {
            return {
              content: [{ type: "text", text: `Error: Task ${args.id} not found.` }],
              isError: true,
            };
          }

          const recoveryNote = recovered
            ? "\nWARNING: Tool-call artifact detected — description was trimmed and/or tags were recovered. Please verify the values below."
            : "";

          return {
            content: [
              {
                type: "text",
                text:
                  `Updated task "${task.title}".${recoveryNote}\n` +
                  `VERIFY: id=${task.id} | status=${task.status} | tags=${JSON.stringify(task.tags)}`,
              },
            ],
          };
        }

        case "task_move": {
          if (!args.id || typeof args.id !== "string") {
            return {
              content: [{ type: "text", text: "Error: 'id' is required." }],
              isError: true,
            };
          }
          // Strict validation — never silently default.
          if (args.status === undefined || args.status === null) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: 'status' is required for task_move. Must be one of: ${VALID_STATUSES.join(", ")}.`,
                },
              ],
              isError: true,
            };
          }
          const status = requireValidStatus(args.status);

          const task = await moveTask(String(args.id), status);
          if (!task) {
            return {
              content: [{ type: "text", text: `Error: Task ${args.id} not found.` }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text:
                  `Moved "${task.title}" to ${task.status}.\n` +
                  `VERIFY: id=${task.id} | status=${task.status} | tags=${JSON.stringify(task.tags)}`,
              },
            ],
          };
        }

        case "task_delete": {
          if (!args.id || typeof args.id !== "string") {
            return {
              content: [{ type: "text", text: "Error: 'id' is required." }],
              isError: true,
            };
          }
          const ok = await deleteTask(String(args.id));
          return {
            content: [
              {
                type: "text",
                text: ok
                  ? `Deleted task ${args.id}.`
                  : `Error: Task ${args.id} not found.`,
              },
            ],
            isError: !ok,
          };
        }

        case "task_list": {
          // "all" hebt den Offen-Default auf; jeder andere Wert wird wie bisher
          // als einzelner Status validiert (Tippfehler sollen weiterhin einen
          // Fehler geben, nicht stillschweigend alles zurueckliefern).
          const wantsAll = args.status === "all";
          const statusFilter =
            !wantsAll && args.status !== undefined && args.status !== null
              ? requireValidStatus(args.status)
              : undefined;
          const queryText = args.query ? String(args.query) : undefined;

          const tasks = await listTasks(undefined, {
            status: statusFilter,
            tag: args.tag ? String(args.tag) : undefined,
            query: queryText,
          });

          // Der Offen-Default greift nur, wenn der Aufrufer WEDER einen Status
          // NOCH eine Suche vorgegeben hat. Eine Suche muss finden, wonach
          // gesucht wird — auch in abgeschlossenen Tasks; sonst waere ein
          // "gibt es das Ticket schon?" truegerisch negativ und man legt ein
          // Duplikat an.
          const defaultFilterApplied =
            !wantsAll && statusFilter === undefined && queryText === undefined;
          const scoped = defaultFilterApplied
            ? tasks.filter((t) => OPEN_STATUSES.includes(t.status))
            : tasks;

          const total = scoped.length;
          const offset = Math.max(0, Number(args.offset) || 0);
          const limit =
            args.limit !== undefined && args.limit !== null
              ? Math.max(1, Number(args.limit))
              : TASK_LIST_DEFAULT_LIMIT;
          const page = scoped.slice(offset, offset + limit);

          const sessionName = await getCurrentSessionName();
          if (total === 0) {
            const hint = defaultFilterApplied
              ? ` with open status (${OPEN_STATUSES.join(", ")}). Use status:"done", status:"archive" or status:"all" to see finished work.`
              : "";
            return {
              content: [
                {
                  type: "text",
                  text: `No tasks found in session "${sessionName}"${hint}`,
                },
              ],
            };
          }

          const lines = page.map(
            (t) =>
              `[${t.status}] ${t.title} (${t.id}) ${t.tags.length > 0 ? "#" + t.tags.join(" #") : ""}`,
          );

          // Kopfzeile sagt IMMER, was gezeigt wird und was fehlt. Ohne diesen
          // Hinweis haelt ein Agent eine gefilterte oder gekuerzte Liste fuer
          // vollstaendig und zieht falsche Schluesse ("gibt es nicht").
          const shown = page.length;
          const scopeNote = defaultFilterApplied
            ? `open only (${OPEN_STATUSES.join(", ")}) — status:"done"/"archive"/"all" for the rest`
            : wantsAll
              ? "all statuses"
              : statusFilter
                ? `status ${statusFilter}`
                : "search across all statuses";
          const pageNote =
            shown < total
              ? ` — showing ${offset + 1}-${offset + shown} of ${total}, use offset/limit for more`
              : ` — ${total} shown`;

          return {
            content: [
              {
                type: "text",
                text: `Session: ${sessionName} [${scopeNote}]${pageNote}\n${lines.join("\n")}`,
              },
            ],
          };
        }

        case "task_append_note": {
          if (!args.id || typeof args.id !== "string") {
            return {
              content: [{ type: "text", text: "Error: 'id' is required." }],
              isError: true,
            };
          }
          if (!args.note || typeof args.note !== "string") {
            return {
              content: [{ type: "text", text: "Error: 'note' is required and must be a non-empty string." }],
              isError: true,
            };
          }
          const task = await appendNote(String(args.id), String(args.note));
          if (!task) {
            return {
              content: [{ type: "text", text: `Error: Task ${args.id} not found.` }],
              isError: true,
            };
          }
          const noteCount = task.notes?.length ?? 0;
          return {
            content: [
              {
                type: "text",
                text: `Appended note to "${task.title}" (${task.id})\nTotal notes: ${noteCount}`,
              },
            ],
          };
        }

        case "task_recall": {
          const context = args.context ? String(args.context) : "";
          const limit = typeof args.limit === "number" ? args.limit : 5;
          const result = await recallTasks(context, limit);
          const sessionName = await getCurrentSessionName();

          if (result.relevant.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No relevant tasks found in session "${sessionName}".\n\nSession Summary: ${result.summary.active} active, ${result.summary.done} done, ${result.summary.blocked} blocked (total: ${result.summary.total})`,
                },
              ],
            };
          }

          const lines = result.relevant.map((t) => {
            const notesPreview =
              t.notes && t.notes.length > 0
                ? `\n  Notes: ${t.notes.length} entries`
                : "";
            const reasons = result.reasons.get(t.id);
            const reasonText =
              reasons && reasons.length > 0
                ? `\n  Matched: ${reasons.map((r) => `${r.field} "${r.matched}"`).join(", ")}`
                : "";
            return `• [${t.status}] ${t.title} (${t.id})${notesPreview}${reasonText}`;
          });

          return {
            content: [
              {
                type: "text",
                text: `Relevant Context Found (${result.relevant.length} tasks):\n\n${lines.join("\n")}\n\nSession Summary: ${result.summary.active} active, ${result.summary.done} done, ${result.summary.blocked} blocked (total: ${result.summary.total})`,
              },
            ],
          };
        }

        case "task_get": {
          if (!args.id || typeof args.id !== "string") {
            return {
              content: [{ type: "text", text: "Error: 'id' is required." }],
              isError: true,
            };
          }
          const task = await getTask(String(args.id));
          if (!task) {
            return {
              content: [{ type: "text", text: `Error: Task ${args.id} not found.` }],
              isError: true,
            };
          }
          const notesText = task.notes?.length
            ? `\nNotes (${task.notes.length}):\n${task.notes.join("\n")}`
            : "";
          return {
            content: [
              {
                type: "text",
                text: `Task: ${task.title}\nID: ${task.id}\nStatus: ${task.status}\nDescription: ${task.description ?? "(none)"}${notesText}\nTags: ${task.tags.join(", ") || "(none)"}\nCreated: ${task.createdAt}\nUpdated: ${task.updatedAt}`,
              },
            ],
          };
        }

        case "session_list": {
          const sessions = await listAllSessions();
          const active = await getCurrentSessionName();
          if (sessions.length === 0) {
            return {
              content: [{ type: "text", text: "No sessions found" }],
            };
          }
          const lines = sessions.map((s) => {
            const marker = s.name === active ? " *" : "";
            return `- ${s.name}${marker}`;
          });
          return {
            content: [
              {
                type: "text",
                text: `Active: ${active}\n\n${lines.join("\n")}`,
              },
            ],
          };
        }

        case "session_switch": {
          if (!args.name || typeof args.name !== "string") {
            return {
              content: [{ type: "text", text: "Error: 'name' is required." }],
              isError: true,
            };
          }
          const targetName = String(args.name);
          const sessions = await listAllSessions();
          const exists = sessions.some((s) => s.name === targetName);
          if (!exists) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Session "${targetName}" not found. Use session_list to see available sessions.`,
                },
              ],
              isError: true,
            };
          }
          await setActiveSession(targetName);
          return {
            content: [
              { type: "text", text: `Switched to session "${targetName}"` },
            ],
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-start if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer();
}

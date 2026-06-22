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

// ---------------------------------------------------------------------------
// Tool-call artifact recovery
// ---------------------------------------------------------------------------

/**
 * Regex that matches the specific mangled tail that AI tool-call clients
 * sometimes append when a long `description` causes parameter bleeding:
 *
 *   </description>
 *   <parameter name="tags">["a","b"]</parameter>
 *   ... (any remaining leaked XML)
 *
 * We anchor to the END of the string (with optional trailing whitespace) so
 * we never accidentally trim mid-description text that happens to mention
 * XML-looking strings.
 *
 * Group 1 (optional): the JSON array inside a <parameter name="tags"> element.
 */
const ARTIFACT_TAIL_RE =
  /<\/description>\s*(?:<parameter\s[^>]*name\s*=\s*["']tags["'][^>]*>([\s\S]*?)<\/parameter>)?([\s\S]*?)\s*$/;

/**
 * Recover a potentially mangled `description` + `tags` pair.
 *
 * Handles the known AI tool-call bug where long descriptions bleed into the
 * next parameter — the `tags` JSON array ends up appended to the description
 * text as literal XML while `tags` arrives empty/missing.
 *
 * Behaviour:
 *  - If the description does NOT end with the artifact tail: returns inputs unchanged.
 *  - If it does:
 *    - Strips the artifact tail from the description.
 *    - When `providedTags` is empty/absent AND a JSON array is found in the
 *      artifact: parses that array and uses it as the recovered tags.
 *    - Logs a warning (stderr) so operators can see recoveries in container logs.
 *
 * Conservative by design: only acts on the specific end-of-string pattern.
 */
function recoverDescriptionAndTags(
  description: string | undefined,
  providedTags: string[] | undefined,
): { description: string | undefined; tags: string[] | undefined; recovered: boolean } {
  if (!description) {
    return { description, tags: providedTags, recovered: false };
  }

  const match = ARTIFACT_TAIL_RE.exec(description);
  // The tail must start with </description> — if the regex matches but the
  // matched portion doesn't contain that sentinel, skip recovery.
  if (!match || !match[0].includes("</description>")) {
    return { description, tags: providedTags, recovered: false };
  }

  // Trim the artifact tail: everything from the first </description> onward.
  const cutIdx = description.indexOf("</description>");
  const cleanDescription = description.slice(0, cutIdx).trimEnd() || undefined;

  // Attempt to parse tags from the captured group if caller sent none.
  let recoveredTags: string[] | undefined = providedTags;
  const hasTags = Array.isArray(providedTags) && providedTags.length > 0;

  if (!hasTags && match[1]) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) {
        recoveredTags = parsed.map(String);
      }
    } catch {
      // Malformed JSON in the artifact — leave tags as-is.
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
          "List all tasks in the current session, optionally filtered. " +
          "Returns tasks for ALL statuses including 'archive' by default.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: VALID_STATUSES,
              description: `Filter by status. Must be one of: ${VALID_STATUSES.join(", ")}. Omit to get all tasks.`,
            },
            tag: {
              type: "string",
              description: "Filter by tag (exact match)",
            },
            query: {
              type: "string",
              description:
                "Search query to filter tasks by title or description (case-insensitive)",
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
          // Validate optional status filter — error if provided but invalid.
          const statusFilter = args.status !== undefined && args.status !== null
            ? requireValidStatus(args.status)
            : undefined;

          const tasks = await listTasks(undefined, {
            status: statusFilter,
            tag: args.tag ? String(args.tag) : undefined,
            query: args.query ? String(args.query) : undefined,
          });
          const sessionName = await getCurrentSessionName();
          if (tasks.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No tasks found in session "${sessionName}"`,
                },
              ],
            };
          }
          const lines = tasks.map(
            (t) =>
              `[${t.status}] ${t.title} (${t.id}) ${t.tags.length > 0 ? "#" + t.tags.join(" #") : ""}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `Session: ${sessionName}\n${lines.join("\n")}`,
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

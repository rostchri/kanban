import { promises as fs, existsSync, mkdirSync } from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { EventEmitter } from "events";
import type { Task, TaskFlowData, TaskStatus, SessionInfo } from "../types.js";

// ---------------------------------------------------------------------------
// Store-level EventEmitter — emits a 'change' event on every mutation.
// Both the MCP server and the HTTP server share this same module instance,
// so a single emit point here covers all write paths.
// ---------------------------------------------------------------------------

/** Payload emitted with every 'change' event. */
export interface StoreChangeEvent {
  /** What kind of mutation happened. */
  type: 'created' | 'updated' | 'moved' | 'deleted';
  taskId: string;
  /** Full task object for created/updated/moved events. Absent for deleted. */
  task?: Task;
  tags: string[];
  status: TaskStatus | null;
  /** Session the task belongs to. */
  session: string;
  /** Unix epoch milliseconds. */
  ts: number;
}

class StoreEventEmitter extends EventEmitter {}

/** Singleton emitter.  Subscribe with: storeEvents.on('change', handler) */
export const storeEvents: StoreEventEmitter = new StoreEventEmitter();

// Prevent the default Node.js MaxListenersExceededWarning from firing when
// many SSE clients connect — each adds one 'change' listener.
storeEvents.setMaxListeners(0);

function emitChange(event: StoreChangeEvent): void {
  storeEvents.emit('change', event);
}

const KANBAN_DIR = path.join(os.homedir(), ".kanban");
const SESSIONS_DIR = path.join(KANBAN_DIR, "sessions");
const ACTIVE_SESSION_FILE = path.join(KANBAN_DIR, "active-session.json");
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const OPENCODE_CONFIG_DIR = path.join(os.homedir(), ".config", "opencode");
const OPENCODE_DATA_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode",
);

function getDefaultData(): TaskFlowData {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    tasks: [],
  };
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function getSessionDir(sessionName: string): string {
  return path.join(SESSIONS_DIR, sessionName);
}

function getSessionDataFile(sessionName: string): string {
  return path.join(getSessionDir(sessionName), "tasks.json");
}

// Active session management

interface ActiveSession {
  name: string;
  setAt: string;
}

export async function getActiveSession(): Promise<string | undefined> {
  try {
    if (!existsSync(ACTIVE_SESSION_FILE)) return undefined;
    const raw = await fs.readFile(ACTIVE_SESSION_FILE, "utf-8");
    const active: ActiveSession = JSON.parse(raw);
    return active.name;
  } catch {
    return undefined;
  }
}

export async function setActiveSession(sessionName: string): Promise<void> {
  ensureDir(KANBAN_DIR);
  const active: ActiveSession = {
    name: sessionName,
    setAt: new Date().toISOString(),
  };
  await fs.writeFile(
    ACTIVE_SESSION_FILE,
    JSON.stringify(active, null, 2),
    "utf-8",
  );
}

// Session detection

async function detectClaudeSessions(): Promise<SessionInfo[]> {
  try {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];
    const entries = await fs.readdir(CLAUDE_PROJECTS_DIR, {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        path: path.join(CLAUDE_PROJECTS_DIR, e.name),
        detectedAt: new Date().toISOString(),
        source: "claude" as const,
      }));
  } catch {
    return [];
  }
}

const OPENCODE_CONFIG_EXCLUDES = new Set([
  "agents",
  "command",
  "commands",
  "modes",
  "plugins",
  "skills",
  "tools",
  "themes",
  "node_modules",
]);

const OPENCODE_DATA_EXCLUDES = new Set([
  "bin",
  "log",
  "repos",
  "snapshot",
  "storage",
  "tool-output",
]);

const ALL_INTERNAL_NAMES = new Set([
  ...OPENCODE_CONFIG_EXCLUDES,
  ...OPENCODE_DATA_EXCLUDES,
]);

async function detectOpencodeSessions(): Promise<SessionInfo[]> {
  // First, try to read from the OpenCode SQLite database (most accurate)
  const dbSessions = await queryOpencodeDatabase();
  if (dbSessions.length > 0) {
    return dbSessions;
  }

  // Fallback: directory-based detection
  return detectOpencodeSessionsFromDirectories();
}

function buildOpencodeSessionsFromRows(
  rows: Array<{ worktree: string | null; name: string | null; time_updated: number | null }>,
): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  const seenPaths = new Set<string>();

  for (const row of rows) {
    if (!row.worktree || row.worktree === "/") continue;
    const normalizedPath = path.normalize(row.worktree);
    if (seenPaths.has(normalizedPath)) continue;
    seenPaths.add(normalizedPath);

    const sessionName = row.name?.trim() || path.basename(normalizedPath);
    sessions.push({
      name: sessionName,
      path: normalizedPath,
      detectedAt: row.time_updated
        ? new Date(row.time_updated).toISOString()
        : new Date().toISOString(),
      source: "opencode" as const,
    });
  }

  return sessions;
}

async function queryOpencodeDatabase(): Promise<SessionInfo[]> {
  const dbPath = path.join(OPENCODE_DATA_DIR, "opencode.db");
  if (!existsSync(dbPath)) {
    return [];
  }

  const SQL = `SELECT id, worktree, name, time_updated FROM project WHERE worktree IS NOT NULL AND worktree != '/' ORDER BY time_updated DESC`;

  // Primary: use Node.js built-in sqlite (Node 22.5+), no external deps needed
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqlite = await import("node:sqlite" as any);
    const db = new sqlite.DatabaseSync(dbPath, { open: true });
    try {
      const rows = db.prepare(SQL).all() as Array<{
        id: string;
        worktree: string | null;
        name: string | null;
        time_updated: number | null;
      }>;
      return buildOpencodeSessionsFromRows(rows);
    } finally {
      db.close();
    }
  } catch {
    // node:sqlite unavailable (Node < 22.5) — fall through to CLI
  }

  // Fallback: sqlite3 CLI (must be installed on the system)
  try {
    const tempQueryFile = path.join(
      os.tmpdir(),
      `opencode-query-${Date.now()}.sql`,
    );
    await fs.writeFile(tempQueryFile, SQL + ";", "utf-8");

    let result: string;
    try {
      result = execSync(`sqlite3 "${dbPath}" < "${tempQueryFile}"`, {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } finally {
      try {
        await fs.unlink(tempQueryFile);
      } catch {
        // ignore cleanup errors
      }
    }

    const rows = result
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        const [, worktree, name, time_updated] = line.split("|");
        return {
          worktree: worktree ?? null,
          name: name ?? null,
          time_updated: time_updated ? parseInt(time_updated) : null,
        };
      });

    return buildOpencodeSessionsFromRows(rows);
  } catch {
    // sqlite3 CLI not installed — return empty to trigger directory fallback
    return [];
  }
}

async function detectOpencodeSessionsFromDirectories(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  // Check ~/.config/opencode/ for project directories
  try {
    if (existsSync(OPENCODE_CONFIG_DIR)) {
      const entries = await fs.readdir(OPENCODE_CONFIG_DIR, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isDirectory() && !OPENCODE_CONFIG_EXCLUDES.has(entry.name)) {
          sessions.push({
            name: entry.name,
            path: path.join(OPENCODE_CONFIG_DIR, entry.name),
            detectedAt: new Date().toISOString(),
            source: "opencode" as const,
          });
        }
      }
    }
  } catch {
    // Ignore errors
  }

  // Check ~/.local/share/opencode/ for session data
  try {
    if (existsSync(OPENCODE_DATA_DIR)) {
      const entries = await fs.readdir(OPENCODE_DATA_DIR, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isDirectory() && !OPENCODE_DATA_EXCLUDES.has(entry.name)) {
          const sessionName = entry.name;
          // Only add if not already found
          if (!sessions.some((s) => s.name === sessionName)) {
            sessions.push({
              name: sessionName,
              path: path.join(OPENCODE_DATA_DIR, entry.name),
              detectedAt: new Date().toISOString(),
              source: "opencode" as const,
            });
          }
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return sessions;
}

function detectGitRepo(): { name: string; path: string } | undefined {
  try {
    const cwd = process.cwd();
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    if (!gitRoot) return undefined;

    const normalizedPath = path.normalize(gitRoot);
    const name = path.basename(normalizedPath);

    return { name, path: normalizedPath };
  } catch {
    return undefined;
  }
}

async function detectGitRepoSessions(): Promise<SessionInfo[]> {
  const repo = detectGitRepo();
  if (!repo) return [];

  return [
    {
      name: repo.name,
      path: repo.path,
      detectedAt: new Date().toISOString(),
      source: "git" as const,
    },
  ];
}

function encodePathLikeClaude(absolutePath: string): string {
  // Claude names its project dirs by encoding the absolute path:
  // replace path separators (and ':' for Windows drive letters) with '-', prepend '-'
  // e.g., /Users/X1/myproject → -Users-X1-myproject
  // e.g., C:\Users\X1\myproject → -C-Users-X1-myproject
  return '-' + absolutePath.replace(/[/\\:]/g, '-');
}

export async function detectSessions(): Promise<SessionInfo[]> {
  try {
    // Detect sessions from all sources: Git (CWD), Claude, and OpenCode
    const [gitSessions, claudeSessions, opencodeSessions] = await Promise.all([
      detectGitRepoSessions(),
      detectClaudeSessions(),
      detectOpencodeSessions(),
    ]);

    // Merge and deduplicate by name
    // Priority: Git > Claude > OpenCode
    const sessionMap = new Map<string, SessionInfo>();

    for (const session of opencodeSessions) {
      sessionMap.set(session.name, session);
    }

    for (const session of claudeSessions) {
      sessionMap.set(session.name, session);
    }

    // Git sessions take highest priority - they reflect the actual working directory
    for (const session of gitSessions) {
      sessionMap.set(session.name, session);
    }

    // Remove Claude sessions that are just encoded path duplicates of a git session.
    // Claude dir names encode the full path (e.g., -Users-X1-project for /Users/X1/project),
    // while git sessions use the plain basename — so they never match by name alone.
    for (const gitSession of gitSessions) {
      const expectedEncoding = encodePathLikeClaude(gitSession.path);
      if (sessionMap.has(expectedEncoding)) {
        sessionMap.delete(expectedEncoding);
      }
    }

    const sessions = Array.from(sessionMap.values());

    if (sessions.length === 0) return [];

    // Sort by most recently modified
    const stats = await Promise.all(
      sessions.map(async (s) => {
        try {
          const stat = await fs.stat(s.path);
          return { ...s, mtime: stat.mtime };
        } catch {
          return { ...s, mtime: new Date(0) };
        }
      }),
    );
    stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return stats.map((s) => ({
      name: s.name,
      path: s.path,
      detectedAt: s.detectedAt,
      source: s.source,
    }));
  } catch {
    return [];
  }
}

export async function detectLatestSession(): Promise<SessionInfo | undefined> {
  const sessions = await detectSessions();

  // If we're in a git repo, prefer the git-detected session
  // even if it's not the most recently modified
  const gitSession = sessions.find((s) => s.source === "git");
  if (gitSession) {
    return gitSession;
  }

  return sessions[0];
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const detected = await detectSessions();
  const detectedNames = new Set(detected.map((s) => s.name));

  // Also include any stored sessions that might not be currently detected
  // (e.g., old projects that were removed from .claude/projects)
  const storedSessions: SessionInfo[] = [];
  if (existsSync(SESSIONS_DIR)) {
    const entries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !detectedNames.has(entry.name) &&
        entry.name !== "independent" &&
        !ALL_INTERNAL_NAMES.has(entry.name)
      ) {
        storedSessions.push({
          name: entry.name,
          path: getSessionDir(entry.name),
          detectedAt: new Date().toISOString(),
          source: "manual" as const,
        });
      }
    }
  }

  // Always include independent mode
  const allSessions = [
    ...detected,
    ...storedSessions,
    {
      name: "independent",
      path: getSessionDir("independent"),
      detectedAt: new Date().toISOString(),
      source: "independent" as const,
    },
  ];

  return allSessions;
}

// Get or initialize the current session name
export async function getCurrentSessionName(): Promise<string> {
  const active = await getActiveSession();
  if (active) {
    // Validate the stored session is still in the known session list.
    // Without this check the file becomes stale after switching projects —
    // any subsequent call would return the old session forever.
    const all = await listAllSessions();
    if (all.some((s) => s.name === active)) return active;
    // Stale — fall through to re-detect
  }

  // Auto-detect and set
  const latest = await detectLatestSession();
  if (latest) {
    await setActiveSession(latest.name);
    return latest.name;
  }

  // Fallback to independent
  await setActiveSession("independent");
  return "independent";
}

// Per-session data operations

async function readSessionData(sessionName: string): Promise<TaskFlowData> {
  const dataFile = getSessionDataFile(sessionName);
  ensureDir(getSessionDir(sessionName));

  try {
    const raw = await fs.readFile(dataFile, "utf-8");
    return JSON.parse(raw) as TaskFlowData;
  } catch {
    const defaultData = getDefaultData();
    await writeSessionData(sessionName, defaultData);
    return defaultData;
  }
}

async function writeSessionData(
  sessionName: string,
  data: TaskFlowData,
): Promise<void> {
  const dataFile = getSessionDataFile(sessionName);
  ensureDir(getSessionDir(sessionName));
  data.updatedAt = new Date().toISOString();
  const tempFile = dataFile + ".tmp";
  await fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tempFile, dataFile);
}

// Task CRUD (session-aware)

export async function listTasks(
  sessionName?: string,
  filter?: { status?: TaskStatus; tag?: string; query?: string },
): Promise<Task[]> {
  const targetSession = sessionName ?? (await getCurrentSessionName());
  const data = await readSessionData(targetSession);
  let tasks = data.tasks;
  if (filter?.status) {
    tasks = tasks.filter((t) => t.status === filter.status);
  }
  if (filter?.tag) {
    tasks = tasks.filter((t) => t.tags.includes(filter.tag!));
  }
  if (filter?.query) {
    const q = filter.query.toLowerCase();
    tasks = tasks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.description?.toLowerCase().includes(q) ?? false),
    );
  }
  return tasks;
}

export async function getTask(
  id: string,
  sessionName?: string,
): Promise<Task | undefined> {
  const targetSession = sessionName ?? (await getCurrentSessionName());
  const data = await readSessionData(targetSession);
  return data.tasks.find((t) => t.id === id);
}

export async function createTask(
  input: {
    title: string;
    description?: string;
    status?: TaskStatus;
    tags?: string[];
    source?: "claude" | "opencode" | "manual";
  },
  sessionName?: string,
): Promise<Task> {
  const targetSession = sessionName ?? (await getCurrentSessionName());
  const data = await readSessionData(targetSession);

  const task: Task = {
    id: generateId(),
    title: input.title,
    description: input.description,
    status: input.status ?? "todo",
    tags: input.tags ?? [],
    source: input.source ?? "manual",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  data.tasks.push(task);
  await writeSessionData(targetSession, data);
  emitChange({
    type: 'created',
    taskId: task.id,
    task,
    tags: task.tags,
    status: task.status,
    session: targetSession,
    ts: Date.now(),
  });
  return task;
}

export async function updateTask(
  id: string,
  input: Partial<Pick<Task, "title" | "description" | "status" | "tags">>,
  sessionName?: string,
): Promise<Task | undefined> {
  const targetSession = sessionName ?? (await getCurrentSessionName());
  const data = await readSessionData(targetSession);
  const idx = data.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return undefined;

  const task = data.tasks[idx];
  const prevStatus = task.status;
  if (input.title !== undefined) task.title = input.title;
  if (input.description !== undefined) task.description = input.description;
  if (input.status !== undefined) task.status = input.status;
  if (input.tags !== undefined) task.tags = input.tags;
  task.updatedAt = new Date().toISOString();

  await writeSessionData(targetSession, data);

  // Determine event type: 'moved' when only the status changed, 'updated' otherwise.
  const eventType =
    input.status !== undefined && input.status !== prevStatus &&
    input.title === undefined && input.description === undefined && input.tags === undefined
      ? 'moved'
      : 'updated';
  emitChange({
    type: eventType,
    taskId: task.id,
    task,
    tags: task.tags,
    status: task.status,
    session: targetSession,
    ts: Date.now(),
  });

  return task;
}

export async function moveTask(
  id: string,
  status: TaskStatus,
  sessionName?: string,
): Promise<Task | undefined> {
  return updateTask(id, { status }, sessionName);
}

export async function deleteTask(
  id: string,
  sessionName?: string,
): Promise<boolean> {
  const targetSession = sessionName ?? (await getCurrentSessionName());
  const data = await readSessionData(targetSession);
  const initialLen = data.tasks.length;
  const deletedTask = data.tasks.find((t) => t.id === id);
  data.tasks = data.tasks.filter((t) => t.id !== id);
  if (data.tasks.length === initialLen) return false;
  await writeSessionData(targetSession, data);
  emitChange({
    type: 'deleted',
    taskId: id,
    tags: deletedTask?.tags ?? [],
    status: deletedTask?.status ?? null,
    session: targetSession,
    ts: Date.now(),
  });
  return true;
}

export async function appendNote(
  id: string,
  note: string,
  sessionName?: string,
): Promise<Task | undefined> {
  const targetSession = sessionName ?? (await getCurrentSessionName());
  const data = await readSessionData(targetSession);
  const idx = data.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return undefined;

  const task = data.tasks[idx];
  if (!task.notes) {
    task.notes = [];
  }
  const timestamp = new Date().toISOString();
  task.notes.push(`[${timestamp}] ${note}`);
  task.updatedAt = timestamp;

  await writeSessionData(targetSession, data);
  emitChange({
    type: 'updated',
    taskId: task.id,
    task,
    tags: task.tags,
    status: task.status,
    session: targetSession,
    ts: Date.now(),
  });
  return task;
}

export async function getAllData(sessionName?: string): Promise<TaskFlowData> {
  const targetSession = sessionName ?? (await getCurrentSessionName());
  const data = await readSessionData(targetSession);

  // Attach session info
  const sessions = await listAllSessions();
  const sessionInfo = sessions.find((s) => s.name === targetSession);
  if (sessionInfo) {
    data.session = sessionInfo;
  }

  return data;
}

// Smart context recall for agent memory

interface MatchReason {
  field: string;
  matched: string;
}

interface ScoredTask {
  task: Task;
  score: number;
  signals: number;
  reasons: MatchReason[];
}

interface RecallResult {
  relevant: Task[];
  reasons: Map<string, MatchReason[]>;
  summary: {
    active: number;
    done: number;
    blocked: number;
    total: number;
  };
  quality: "excellent" | "good" | "fair" | "poor";
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "day",
  "get",
  "has",
  "him",
  "his",
  "how",
  "its",
  "may",
  "new",
  "now",
  "old",
  "see",
  "two",
  "who",
  "boy",
  "did",
  "she",
  "use",
  "her",
  "way",
  "many",
  "oil",
  "sit",
  "set",
  "run",
  "eat",
  "far",
  "sea",
  "eye",
  "ago",
  "off",
  "too",
  "any",
  "say",
  "man",
  "try",
  "ask",
  "end",
  "why",
  "let",
  "put",
  "say",
  "she",
  "try",
  "way",
  "own",
  "say",
  "too",
  "old",
  "tell",
  "very",
  "when",
  "much",
  "would",
  "there",
  "their",
  "what",
  "said",
  "each",
  "which",
  "will",
  "about",
  "could",
  "other",
  "after",
  "first",
  "never",
  "these",
  "think",
  "where",
  "being",
  "every",
  "great",
  "might",
  "shall",
  "still",
  "those",
  "while",
  "this",
  "that",
  "with",
  "have",
  "from",
  "they",
  "know",
  "want",
  "been",
  "good",
  "much",
  "some",
  "time",
  "very",
  "when",
  "come",
  "here",
  "just",
  "like",
  "long",
  "make",
  "many",
  "over",
  "such",
  "take",
  "than",
  "them",
  "well",
  "were",
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .filter((w) => !STOP_WORDS.has(w));
}

function getTaskFields(task: Task): { [key: string]: string } {
  return {
    title: task.title.toLowerCase(),
    tags: task.tags.join(" ").toLowerCase(),
    description: (task.description || "").toLowerCase(),
    notes: (task.notes || []).join(" ").toLowerCase(),
  };
}

function scoreTask(task: Task, queryWords: string[]): ScoredTask {
  let score = 0;
  let signals = 0;
  const reasons: MatchReason[] = [];
  const fields = getTaskFields(task);

  // Title matches (highest weight: 5)
  for (const word of queryWords) {
    if (fields.title.includes(word)) {
      score += 5;
      signals++;
      reasons.push({ field: "title", matched: word });
      break; // Only count title once per word
    }
  }

  // Tag matches (weight: 4)
  for (const word of queryWords) {
    if (fields.tags.includes(word)) {
      score += 4;
      signals++;
      reasons.push({ field: "tag", matched: word });
      break;
    }
  }

  // Description matches (weight: 2)
  for (const word of queryWords) {
    if (fields.description.includes(word)) {
      score += 2;
      signals++;
      reasons.push({ field: "description", matched: word });
      break;
    }
  }

  // Notes matches (lowest weight: 1)
  for (const word of queryWords) {
    if (fields.notes.includes(word)) {
      score += 1;
      signals++;
      reasons.push({ field: "notes", matched: word });
      break;
    }
  }

  // Recency boost
  const age = Date.now() - new Date(task.updatedAt).getTime();
  const hoursOld = age / (1000 * 60 * 60);
  if (hoursOld < 1) {
    score += 2;
  } else if (hoursOld < 24) {
    score += 1;
  }

  // Status boost
  if (task.status === "in-progress") {
    score += 2;
    signals++;
  } else if (task.status === "blocked") {
    score += 1;
    signals++;
  }

  return { task, score, signals, reasons };
}

export async function recallTasks(
  context: string,
  limit: number = 5,
  sessionName?: string,
): Promise<RecallResult> {
  const targetSession = sessionName ?? (await getCurrentSessionName());
  const data = await readSessionData(targetSession);

  if (data.tasks.length === 0) {
    return {
      relevant: [],
      reasons: new Map(),
      summary: { active: 0, done: 0, blocked: 0, total: 0 },
      quality: "poor",
    };
  }

  const queryWords = extractKeywords(context);

  // Score all tasks
  const scored = data.tasks.map((task) => scoreTask(task, queryWords));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Determine quality based on top score
  const maxScore = scored[0]?.score || 0;
  let quality: "excellent" | "good" | "fair" | "poor";
  let actualLimit: number;

  if (maxScore >= 10) {
    quality = "excellent";
    actualLimit = Math.min(limit, 2);
  } else if (maxScore >= 7) {
    quality = "good";
    actualLimit = Math.min(limit, 3);
  } else if (maxScore >= 5) {
    quality = "fair";
    actualLimit = 1;
  } else {
    quality = "poor";
    actualLimit = 0;
  }

  // Filter by minimum threshold and signal count
  const filtered = scored
    .filter((s) => s.score >= 5 && s.signals >= 2)
    .slice(0, actualLimit);

  const relevant = filtered.map((s) => s.task);
  const reasons = new Map(filtered.map((s) => [s.task.id, s.reasons]));

  // Calculate summary
  const summary = {
    active: data.tasks.filter((t) => t.status === "in-progress").length,
    done: data.tasks.filter((t) => t.status === "done").length,
    blocked: data.tasks.filter((t) => t.status === "blocked").length,
    total: data.tasks.length,
  };

  return { relevant, reasons, summary, quality };
}

// ---------------------------------------------------------------------------
// Cross-process change detection via fs.watch on the sessions directory.
// The MCP server and the HTTP server run as SEPARATE OS processes — an
// in-process EventEmitter cannot bridge that gap.  We bridge it via the
// filesystem: every mutation writes a tasks.json file, and fs.watch fires
// in the HTTP-server process so we can diff & emit the SSE change event.
// ---------------------------------------------------------------------------

/**
 * Lightweight snapshot of a single task, used for change detection.
 * Deliberately small — we only store fields that affect `StoreChangeEvent`.
 */
interface TaskSnapshot {
  id: string;
  status: TaskStatus;
  /** Tag list serialised to a stable string for cheap equality check. */
  tagsKey: string;
  updatedAt: string;
}

/** In-memory snapshot: sessionName → Map<taskId, TaskSnapshot> */
const _watchSnapshot = new Map<string, Map<string, TaskSnapshot>>();

/** Last observed mtime (ms) per session name, used to detect file changes. */
const _pollMtimes = new Map<string, number>();

// ---------------------------------------------------------------------------
// Test-support hooks (tree-shaken in production builds via lack of callers).
// Allows unit tests to inject a temporary sessions directory without touching
// the real ~/.kanban/sessions path.
// ---------------------------------------------------------------------------

/** Effective sessions directory used by all poll/watch functions. */
let _sessionsDir: string = SESSIONS_DIR;

/** @internal Allow tests to inject a temporary sessions directory. */
export function _testOverrideSessionsDir(dir: string): void {
  _sessionsDir = dir;
}

/** @internal Reset all poll-related state between tests. */
export function _testResetPollState(): void {
  _watchSnapshot.clear();
  _pollMtimes.clear();
  _sessionsDir = SESSIONS_DIR;
}

/** Resolve the tasks.json path for a session in the current _sessionsDir. */
function _sessionDataFile(session: string): string {
  return path.join(_sessionsDir, session, 'tasks.json');
}

function _taskToSnapshot(task: Task): TaskSnapshot {
  return {
    id: task.id,
    status: task.status,
    tagsKey: [...task.tags].sort().join('\0'),
    updatedAt: task.updatedAt,
  };
}

/**
 * Build a snapshot map for one session's task array.
 */
function _buildSessionSnapshot(tasks: Task[]): Map<string, TaskSnapshot> {
  const m = new Map<string, TaskSnapshot>();
  for (const t of tasks) {
    m.set(t.id, _taskToSnapshot(t));
  }
  return m;
}

/**
 * Diff the current tasks of one session against the stored snapshot and emit
 * `storeEvents` change events for every detected mutation.
 *
 * @param session  Session name (used in the emitted event).
 * @param tasks    Fresh task list read from disk.
 */
function _diffAndEmit(session: string, tasks: Task[]): void {
  const prev = _watchSnapshot.get(session) ?? new Map<string, TaskSnapshot>();
  const next = _buildSessionSnapshot(tasks);

  // Detect created tasks
  for (const [id, snap] of next) {
    if (!prev.has(id)) {
      const task = tasks.find((t) => t.id === id)!;
      emitChange({
        type: 'created',
        taskId: id,
        task,
        tags: task.tags,
        status: snap.status,
        session,
        ts: Date.now(),
      });
    }
  }

  // Detect deleted tasks
  for (const [id, prevSnap] of prev) {
    if (!next.has(id)) {
      emitChange({
        type: 'deleted',
        taskId: id,
        // tags/status from the snapshot we still have
        tags: prevSnap.tagsKey ? prevSnap.tagsKey.split('\0').filter(Boolean) : [],
        status: prevSnap.status,
        session,
        ts: Date.now(),
      });
    }
  }

  // Detect updated / moved tasks
  for (const [id, snap] of next) {
    const p = prev.get(id);
    if (!p) continue; // already handled as 'created' above

    // Skip if nothing relevant changed (updatedAt is our cheapest guard)
    if (p.updatedAt === snap.updatedAt) continue;

    const task = tasks.find((t) => t.id === id)!;
    const statusChanged = p.status !== snap.status;
    const tagsChanged = p.tagsKey !== snap.tagsKey;

    // 'moved': only the status column changed (mirrors updateTask logic)
    const eventType: StoreChangeEvent['type'] =
      statusChanged && !tagsChanged ? 'moved' : 'updated';

    emitChange({
      type: eventType,
      taskId: id,
      task,
      tags: task.tags,
      status: snap.status,
      session,
      ts: Date.now(),
    });
  }

  // Update snapshot
  _watchSnapshot.set(session, next);
}

/**
 * Load the initial snapshot for all existing sessions so the first poll tick
 * doesn't produce spurious 'created' events for pre-existing tasks.
 */
async function _initWatchSnapshot(): Promise<void> {
  if (!existsSync(_sessionsDir)) return;

  let entries: string[];
  try {
    const dirEntries = await fs.readdir(_sessionsDir, { withFileTypes: true });
    entries = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (session) => {
      const dataFile = _sessionDataFile(session);
      try {
        const raw = await fs.readFile(dataFile, 'utf-8');
        const data: TaskFlowData = JSON.parse(raw);
        _watchSnapshot.set(session, _buildSessionSnapshot(data.tasks ?? []));
      } catch {
        // Session dir exists but has no valid tasks.json yet — that's fine.
        _watchSnapshot.set(session, new Map());
      }
    }),
  );
}

/**
 * Start polling the sessions directory for cross-process mutations.
 *
 * Call this ONCE in the HTTP-server process (startDashboardServer).
 * The MCP-server process does NOT need this watcher — it emits in-process.
 *
 * Mechanism:
 *  - A `setInterval` tick runs every POLL_INTERVAL_MS (1000 ms).
 *  - Each tick scans _sessionsDir via `fs.promises.readdir`, then checks the
 *    mtime of each session's `tasks.json` via `fs.promises.stat`.
 *  - When a mtime has changed since the last recorded value the file is
 *    re-read and diffed against the in-memory snapshot; per-task
 *    `storeEvents` change events are emitted for each detected mutation.
 *  - JSON parse errors from partial/atomic writes are caught and skipped —
 *    the next poll tick will retry automatically.
 *  - The interval is unref()d so it does not prevent process exit.
 *
 * Why polling instead of fs.watch:
 *  - `fs.watch({ recursive: true })` is unreliable on Linux (Docker volume +
 *    atomic-rename writes) — it stops firing after a period of uptime without
 *    a process restart, causing SSE to go silent permanently.
 *  - A 1 s poll interval is imperceptible for a Kanban UI and introduces
 *    negligible I/O (only stat() calls unless mtime changed).
 */

/** Poll interval in milliseconds. */
const POLL_INTERVAL_MS = 1000;

/**
 * Single poll tick: scan all session directories, check mtimes, diff + emit.
 */
async function _pollTick(): Promise<void> {
  if (!existsSync(_sessionsDir)) return;

  let sessionNames: string[];
  try {
    const entries = await fs.readdir(_sessionsDir, { withFileTypes: true });
    sessionNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return; // _sessionsDir temporarily unreadable — skip this tick
  }

  await Promise.all(
    sessionNames.map(async (session) => {
      const dataFile = _sessionDataFile(session);
      let mtime: number;
      try {
        const stat = await fs.stat(dataFile);
        mtime = stat.mtimeMs;
      } catch {
        // tasks.json doesn't exist yet for this session — skip
        return;
      }

      const prevMtime = _pollMtimes.get(session);
      if (prevMtime === mtime) return; // nothing changed

      // mtime changed (or first observation) — record and diff
      _pollMtimes.set(session, mtime);

      // Skip diff on first observation to avoid phantom 'created' events for
      // tasks that were already in the snapshot built by _initWatchSnapshot.
      if (prevMtime === undefined) return;

      try {
        const raw = await fs.readFile(dataFile, 'utf-8');
        const data: TaskFlowData = JSON.parse(raw);
        _diffAndEmit(session, data.tasks ?? []);
      } catch {
        // Partial/atomic write in progress — skip; next tick will retry.
      }
    }),
  );
}

export async function watchStore(): Promise<void> {
  ensureDir(_sessionsDir);

  // Populate initial snapshot before polling to avoid false 'created' events.
  await _initWatchSnapshot();

  // Seed mtimes from disk so the very first poll tick has a baseline and does
  // not re-emit events for files that already existed at startup.
  if (existsSync(_sessionsDir)) {
    try {
      const entries = await fs.readdir(_sessionsDir, { withFileTypes: true });
      await Promise.all(
        entries
          .filter((e) => e.isDirectory())
          .map(async (e) => {
            const dataFile = _sessionDataFile(e.name);
            try {
              const stat = await fs.stat(dataFile);
              _pollMtimes.set(e.name, stat.mtimeMs);
            } catch {
              // no tasks.json yet — will be picked up once it appears
            }
          }),
      );
    } catch {
      // best-effort
    }
  }

  const interval = setInterval(() => {
    _pollTick().catch(() => {
      // _pollTick is best-effort; ignore errors to keep the interval alive
    });
  }, POLL_INTERVAL_MS);

  // Prevent the interval from keeping the process alive after all other work
  // is done (e.g., during graceful shutdown).
  interval.unref();
}

// Legacy init (creates dirs if needed)
export async function initStorage(): Promise<void> {
  ensureDir(KANBAN_DIR);
  ensureDir(SESSIONS_DIR);
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `tf-${ts}-${rand}`;
}

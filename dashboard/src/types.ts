export type TaskStatus = "todo" | "in-progress" | "done" | "blocked";

/**
 * Optional attribution of a single note (who wrote it, with which model).
 * Stored in Task.noteMeta, index-aligned with Task.notes.
 */
export interface NoteMeta {
  /** Model id, e.g. "anthropic/claude-sonnet-5-5" */
  model?: string;
  /** Agent, e.g. "main" or a subagent type like "my-svelte-developer" */
  agent?: string;
  /**
   * Canonical chatroom agent identity that wrote the note (e.g.
   * "agent-abc123"), set by the client hook. Same sanitize rules as
   * model/agent (max 120 chars, charset [A-Za-z0-9_.:[]/@+-]).
   */
  agentId?: string;
}

/**
 * Deterministic creator attribution, set once at task creation and never
 * modified afterwards (task_update must not touch it).
 */
export interface TaskCreatedBy {
  /** Canonical chatroom agent identity (max 120 chars, charset [A-Za-z0-9_.:[]/@+-]). */
  agentId: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  /** Who created this task (absent for legacy tasks; never backdated). */
  createdBy?: TaskCreatedBy;
  notes?: string[];
  /**
   * Optional per-note attribution, index-aligned with `notes`
   * (`noteMeta[i]` belongs to `notes[i]`). Entries are `null` for notes
   * without attribution (all legacy notes). May be shorter than `notes`
   * or absent entirely: treat missing entries as "no attribution".
   */
  noteMeta?: (NoteMeta | null)[];
  status: TaskStatus;
  tags: string[];
  source: "claude" | "opencode" | "manual";
  createdAt: string;
  updatedAt: string;
}

export interface SessionInfo {
  name: string;
  path: string;
  detectedAt: string;
  source: "claude" | "opencode" | "manual" | "independent" | "git";
}

export interface TaskFlowData {
  version: number;
  updatedAt: string;
  session?: SessionInfo;
  tasks: Task[];
}

export interface SessionsData {
  sessions: SessionInfo[];
  active: string | undefined;
}

export const STATUS_ORDER: TaskStatus[] = [
  "todo",
  "in-progress",
  "done",
  "blocked",
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  "in-progress": "In Progress",
  done: "Done",
  blocked: "Blocked",
};

export const STATUS_COLORS: Record<TaskStatus, string> = {
  todo: "#F59E0B",
  "in-progress": "#3B82F6",
  done: "#10B981",
  blocked: "#EF4444",
};

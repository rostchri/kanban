export type TaskStatus = "todo" | "in-progress" | "done" | "blocked" | "archive";

/**
 * Optional attribution of a single note (who wrote it, with which model).
 * Stored in Task.noteMeta, index-aligned with Task.notes.
 */
export interface NoteMeta {
  /** Model id, e.g. "anthropic/claude-sonnet-5-5" */
  model?: string;
  /** Agent, e.g. "main" or a subagent type like "my-svelte-developer" */
  agent?: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
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

export const VALID_STATUSES: TaskStatus[] = [
  "todo",
  "in-progress",
  "done",
  "blocked",
  "archive",
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  "in-progress": "In Progress",
  done: "Done",
  blocked: "Blocked",
  archive: "Archive",
};

export const STATUS_COLORS: Record<TaskStatus, string> = {
  todo: "#F59E0B",
  "in-progress": "#3B82F6",
  done: "#10B981",
  blocked: "#EF4444",
  archive: "#6B7280",
};

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  getAllData,
  listAllSessions,
  getActiveSession,
  setActiveSession,
  getCurrentSessionName,
  moveTask,
  deleteTask,
  storeEvents,
  watchStore,
  type StoreChangeEvent,
} from '../storage/store.js';
import { VALID_STATUSES } from '../types.js';

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

const SSE_HEARTBEAT_MS = 20_000;

/**
 * Parse a comma-separated ?tags=a,b,c query parameter into a lowercase array.
 * Returns an empty array when the parameter is absent or empty.
 */
function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/**
 * Returns true when the event matches the optional tag/session filters.
 * - tagFilter: OR-match — event passes when ANY tag in the filter appears in event.tags
 * - sessionFilter: exact match against event.session
 */
function matchesFilter(
  event: StoreChangeEvent,
  tagFilter: string[],
  sessionFilter: string | null,
): boolean {
  if (sessionFilter && event.session !== sessionFilter) return false;
  if (tagFilter.length > 0) {
    const eventTagsLower = event.tags.map((t) => t.toLowerCase());
    if (!tagFilter.some((f) => eventTagsLower.includes(f))) return false;
  }
  return true;
}

/**
 * Handle GET /api/events — Server-Sent Events stream.
 *
 * Query parameters:
 *   ?tags=a,b   — OR-filter by tag (case-insensitive)
 *   ?session=X  — filter by session name
 *
 * Protocol:
 *   - Sends `event: ready\ndata: {}\n\n` immediately after connect.
 *   - Forwards store 'change' events that pass the filter as `event: change\ndata: <json>\n\n`.
 *   - Sends `: ping\n\n` heartbeats every 20 s to prevent proxy/idle timeouts.
 *   - Cleans up listener + heartbeat interval on client disconnect.
 */
function handleSseRequest(req: IncomingMessage, res: ServerResponse, port: number): void {
  // Parse filters from query string
  const rawUrl = req.url ?? '/api/events';
  const urlObj = new URL(rawUrl, `http://localhost:${port}`);
  const tagFilter = parseTags(urlObj.searchParams.get('tags'));
  const sessionFilter = urlObj.searchParams.get('session');

  // SSE response headers.
  // Note: CORS headers (Access-Control-Allow-Origin etc.) are already set via
  // res.setHeader() in the outer request handler before routing; writeHead merges them.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',   // disable nginx/Traefik response buffering
  });

  // Flush headers immediately so the client sees 200 + SSE headers right away.
  // ServerResponse.flushHeaders() is part of Node's http module (Node 13.2+).
  res.flushHeaders();

  // Send initial ready event so the client knows the connection is live
  res.write('event: ready\ndata: {}\n\n');

  // Heartbeat to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // connection already gone — cleanup handled by 'close' event below
    }
  }, SSE_HEARTBEAT_MS);

  // Forward matching store events to this SSE client
  const changeHandler = (event: StoreChangeEvent): void => {
    if (!matchesFilter(event, tagFilter, sessionFilter)) return;
    try {
      res.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      // write failed, client disconnected — cleanup below
    }
  };

  storeEvents.on('change', changeHandler);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    storeEvents.off('change', changeHandler);
  });
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DASHBOARD_DIR = path.resolve(__dirname, '../../dashboard/dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createDashboardServer(port: number = 3456): Server {
  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // CORS - only allow same-origin requests since dashboard is served from this server
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:' + port);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // API endpoints
    if (url.startsWith('/api/')) {
      try {
        // GET /api/tasks - Get tasks for current or specified session
        if (url === '/api/tasks' && method === 'GET') {
          const data = await getAllData();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
          return;
        }

        // GET /api/sessions - List all available sessions
        if (url === '/api/sessions' && method === 'GET') {
          const sessions = await listAllSessions();
          const active = await getCurrentSessionName();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessions, active }));
          return;
        }

        // GET /api/sessions/active - Get active session
        if (url === '/api/sessions/active' && method === 'GET') {
          const active = await getActiveSession();
          const current = await getCurrentSessionName();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ active, current }));
          return;
        }

        // POST /api/sessions/active - Set active session
        if (url === '/api/sessions/active' && method === 'POST') {
          let body = '';
          let bodySize = 0;
          let aborted = false;
          req.on('data', (chunk) => {
            if (aborted) return;
            bodySize += chunk.length;
            if (bodySize > MAX_BODY_SIZE) {
              aborted = true;
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Request body too large' }));
              return;
            }
            body += chunk;
          });
          req.on('end', async () => {
            if (aborted) return;
            try {
              const { name } = JSON.parse(body);
              if (!name || typeof name !== 'string') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Session name required' }));
                return;
              }
              await setActiveSession(name);
              const data = await getAllData(name);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(data));
            } catch (err: any) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // GET /api/events - Server-Sent Events stream with optional tag/session filter
        if (url.startsWith('/api/events') && method === 'GET') {
          handleSseRequest(req, res, port);
          // Do NOT call res.end() — the connection stays open until the client disconnects.
          return;
        }

        // POST /api/tasks/:id/status  — move a task to a different status column.
        // Body: { "status": "<enum>" }
        // Returns: the updated task as JSON, or an error object.
        // This write path triggers the Store's EventEmitter → SSE/polling consumers
        // see the change in real time, consistent with MCP-originated mutations.
        const taskMoveMatch = url.match(/^\/api\/tasks\/([^/]+)\/(?:status|move)$/);
        if (taskMoveMatch && method === 'POST') {
          const taskId = decodeURIComponent(taskMoveMatch[1]);
          let body = '';
          let bodySize = 0;
          let aborted = false;
          req.on('data', (chunk) => {
            if (aborted) return;
            bodySize += chunk.length;
            if (bodySize > MAX_BODY_SIZE) {
              aborted = true;
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Request body too large' }));
              return;
            }
            body += chunk;
          });
          req.on('end', async () => {
            if (aborted) return;
            try {
              let parsed: unknown;
              try {
                parsed = JSON.parse(body);
              } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                return;
              }
              if (
                typeof parsed !== 'object' ||
                parsed === null ||
                !('status' in parsed)
              ) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Body must contain a "status" field.' }));
                return;
              }
              const { status } = parsed as Record<string, unknown>;
              if (typeof status !== 'string' || !(VALID_STATUSES as string[]).includes(status)) {
                res.writeHead(422, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: `Invalid status: "${status}". Must be one of: ${VALID_STATUSES.join(', ')}.`,
                  }),
                );
                return;
              }
              const task = await moveTask(taskId, status as (typeof VALID_STATUSES)[number]);
              if (!task) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Task "${taskId}" not found.` }));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(task));
            } catch (err: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // DELETE /api/tasks/:id  — delete a task.
        // Returns: { "deleted": "<id>" } on success, 404 if not found.
        // Triggers the Store's EventEmitter → SSE 'deleted' event (consistent with
        // MCP-originated deletions).
        const taskDeleteMatch = url.match(/^\/api\/tasks\/([^/]+)$/);
        if (taskDeleteMatch && method === 'DELETE') {
          const taskId = decodeURIComponent(taskDeleteMatch[1]);
          try {
            const ok = await deleteTask(taskId);
            if (!ok) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Task "${taskId}" not found.` }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ deleted: taskId }));
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        // 404 for unknown API routes
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
    }

    // Static files
    const safeUrl = url === '/' ? 'index.html' : url;
    // Prevent path traversal: reject URLs with .. or null bytes
    if (safeUrl.includes('..') || safeUrl.includes('\0')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    let filePath = path.join(DASHBOARD_DIR, safeUrl);
    const ext = path.extname(filePath).toLowerCase();

    // If no extension, try .html (SPA routing)
    if (!ext && !url.startsWith('/api/')) {
      filePath += '.html';
    }

    // Resolve and ensure the final path stays within DASHBOARD_DIR
    const resolvedDashboard = path.resolve(DASHBOARD_DIR);
    let resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(resolvedDashboard)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    try {
      if (!existsSync(resolvedPath)) {
        // SPA fallback: serve index.html for non-API routes
        if (!url.startsWith('/api/')) {
          resolvedPath = path.join(DASHBOARD_DIR, 'index.html');
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
      }

      const content = await fs.readFile(resolvedPath);
      const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mimeType });
      res.end(content);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  });

  return server;
}

export async function startDashboardServer(port: number = 3456): Promise<Server> {
  // Check if dashboard is built
  if (!existsSync(DASHBOARD_DIR)) {
    throw new Error(
      `Dashboard not built. Run 'npm run build:dashboard' first.\nExpected: ${DASHBOARD_DIR}`
    );
  }

  // Start fs.watch-based cross-process change detection.
  // This bridges the process boundary between the MCP-server process (which
  // writes tasks.json) and this HTTP-server process (which serves /api/events).
  // The watcher emits on `storeEvents` — the same emitter the SSE handler listens
  // to — so no changes to the SSE logic are needed.
  await watchStore();

  const server = createDashboardServer(port);
  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      console.log(`CWIM Kanban dashboard running at http://localhost:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

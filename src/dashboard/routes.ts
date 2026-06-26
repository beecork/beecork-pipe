// Dashboard route handlers. Each entry is keyed by `<METHOD> <pathPattern>` where
// pathPattern is a regex string (or exact path). The dispatcher in server.ts
// chooses the first matching entry and invokes its handler.

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from '../db/index.js';
import { logger } from '../util/logger.js';
import { validateTabName, validateTabNameOrDefault, getConfig } from '../config.js';
import { createTabRecord } from '../db/index.js';
import { VERSION } from '../version.js';
import { getDaemonPid } from '../cli/helpers.js';
import { MESSAGE_LIMITS } from '../util/text.js';
import { TabStore } from '../session/tab-store.js';
import { PendingMessageStore } from '../session/pending-store.js';
import { expandHome } from '../util/paths.js';

const execFileAsync = promisify(execFile);

/**
 * Check whether a workingDir resolves under an allowed root.
 * Allowed roots: tabs.default.workingDir, projectScanPaths, $HOME.
 * This mirrors the allowlist used by projects/manager.ts:createProject so the
 * dashboard cannot create a tab pointing at /etc or another user's home.
 */
function isAllowedWorkingDir(dir: string): boolean {
  const resolved = path.resolve(expandHome(dir));
  const config = getConfig();
  const home = os.homedir();
  const roots = [config.tabs?.default?.workingDir, ...(config.projectScanPaths ?? []), home]
    .filter((r): r is string => typeof r === 'string' && r.length > 0)
    .map((r) => path.resolve(expandHome(r)));
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

const SAFE_NPM_PACKAGE = /^[@a-zA-Z0-9_/.-]+$/;

interface SendMessageBody {
  message: string;
}
interface CreateTabBody {
  name: string;
  workingDir?: string;
  systemPrompt?: string;
}
interface CreateTaskBody {
  name: string;
  scheduleType?: string;
  schedule: string;
  tabName?: string;
  message: string;
}
interface CreateMemoryBody {
  content: string;
  tabName?: string;
}
interface ComputerUseBody {
  enabled: boolean;
}
interface EnableCapBody {
  apiKey?: string;
}

function parseIntParam(value: string | null, def: number, max: number): number {
  if (value === null) return def;
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) return def;
  return Math.min(n, max);
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<string | null> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MESSAGE_LIMITS.HTTP_BODY) {
      json(res, { error: 'Payload too large' }, 413);
      req.destroy();
      return null;
    }
  }
  return body;
}

export interface RouteCtx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  path: string;
}

type RouteHandler = (ctx: RouteCtx) => Promise<void> | void;

interface RouteEntry {
  method: string;
  test: (path: string) => boolean;
  handler: RouteHandler;
}

function exactPath(p: string): (path: string) => boolean {
  return (path) => path === p;
}
function regexPath(re: RegExp): (path: string) => boolean {
  return (path) => re.test(path);
}

export const ROUTES: RouteEntry[] = [
  // SSE — never log a "broken pipe" write as a hard error
  {
    method: 'GET',
    test: exactPath('/api/events'),
    handler: ({ req, res }) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
      // Skip pushes when nothing changed — without this every 2s tick wrote
      // the full tab payload even when the daemon was idle.
      let lastPayload = '';
      const interval = setInterval(() => {
        if (res.writableEnded) return;
        try {
          const tabs = TabStore.listAll().map((t) => ({
            name: t.name,
            status: t.status,
            last_activity_at: t.lastActivityAt,
          }));
          const activeCount = tabs.filter((t) => t.status === 'running').length;
          const payload = JSON.stringify({ type: 'update', tabs, activeTabs: activeCount });
          if (payload === lastPayload) return;
          lastPayload = payload;
          res.write(`data: ${payload}\n\n`);
        } catch (err) {
          logger.warn('Dashboard SSE tick failed:', err);
        }
      }, 2000);
      req.on('close', () => clearInterval(interval));
    },
  },

  // POST /api/tabs/:name/send
  {
    method: 'POST',
    test: regexPath(/^\/api\/tabs\/[^/]+\/send$/),
    handler: async ({ req, res, path }) => {
      const body = await readBody(req, res);
      if (body === null) return;
      let parsed: SendMessageBody;
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, { error: 'Invalid JSON' }, 400);
        return;
      }
      if (!parsed.message) {
        json(res, { error: 'Missing message' }, 400);
        return;
      }
      const tabName = decodeURIComponent(path.split('/')[3]);
      const err = validateTabNameOrDefault(tabName);
      if (err) {
        json(res, { error: err }, 400);
        return;
      }
      PendingMessageStore.enqueueUser(tabName, parsed.message, getDb());
      json(res, { success: true, tab: tabName });
    },
  },

  // POST /api/tabs — create
  {
    method: 'POST',
    test: exactPath('/api/tabs'),
    handler: async ({ req, res }) => {
      const body = await readBody(req, res);
      if (body === null) return;
      let parsed: CreateTabBody;
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, { error: 'Invalid JSON' }, 400);
        return;
      }
      if (!parsed.name) {
        json(res, { error: 'Missing tab name' }, 400);
        return;
      }
      const err = validateTabName(parsed.name);
      if (err) {
        json(res, { error: err }, 400);
        return;
      }
      if (parsed.workingDir && !isAllowedWorkingDir(parsed.workingDir)) {
        json(
          res,
          {
            error:
              'workingDir must be under the workspace root, a project scan path, or your home directory',
          },
          400,
        );
        return;
      }
      try {
        createTabRecord(getDb(), {
          name: parsed.name,
          workingDir: parsed.workingDir,
          systemPrompt: parsed.systemPrompt,
        });
        json(res, { success: true, name: parsed.name });
      } catch (e) {
        json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
      }
    },
  },

  // DELETE /api/tabs/:name
  {
    method: 'DELETE',
    test: regexPath(/^\/api\/tabs\/[^/]+$/),
    handler: ({ res, path }) => {
      const tabName = decodeURIComponent(path.split('/')[3]);
      TabStore.deleteWithMessages(tabName);
      json(res, { success: true });
    },
  },

  // POST /api/tasks or /api/crons
  {
    method: 'POST',
    test: (path) => path === '/api/tasks' || path === '/api/crons',
    handler: async ({ req, res }) => {
      const body = await readBody(req, res);
      if (body === null) return;
      let parsed: CreateTaskBody;
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, { error: 'Invalid JSON' }, 400);
        return;
      }
      if (!parsed.name || !parsed.schedule || !parsed.message) {
        json(res, { error: 'Missing required fields' }, 400);
        return;
      }
      const effectiveTab = parsed.tabName || 'default';
      const tabErr = validateTabNameOrDefault(effectiveTab);
      if (tabErr) {
        json(res, { error: tabErr }, 400);
        return;
      }
      const scheduleType = parsed.scheduleType || 'every';
      const { validateSchedule } = await import('../tasks/scheduler.js');
      const scheduleErr = validateSchedule(scheduleType, parsed.schedule);
      if (scheduleErr) {
        json(res, { error: scheduleErr }, 400);
        return;
      }
      const id = crypto.randomUUID();
      const { TaskStore } = await import('../tasks/store.js');
      new TaskStore().add({
        id,
        name: parsed.name,
        scheduleType: scheduleType as 'at' | 'every' | 'cron',
        schedule: parsed.schedule,
        tabName: effectiveTab,
        message: parsed.message,
        payloadType: 'agentTurn',
        enabled: true,
        createdAt: new Date().toISOString(),
        lastRunAt: null,
        nextRunAt: null,
      });
      json(res, { success: true, id });
    },
  },

  // DELETE /api/tasks/:id or /api/crons/:id
  {
    method: 'DELETE',
    test: (path) => /^\/api\/(tasks|crons)\/[^/]+$/.test(path),
    handler: async ({ res, path }) => {
      const taskId = decodeURIComponent(path.split('/')[3]);
      const { TaskStore } = await import('../tasks/store.js');
      new TaskStore().delete(taskId);
      json(res, { success: true });
    },
  },

  // GET /api/watchers
  {
    method: 'GET',
    test: exactPath('/api/watchers'),
    handler: async ({ res }) => {
      const { WatcherStore } = await import('../watchers/store.js');
      json(res, new WatcherStore().list());
    },
  },

  // DELETE /api/watchers/:id
  {
    method: 'DELETE',
    test: regexPath(/^\/api\/watchers\/[^/]+$/),
    handler: async ({ res, path }) => {
      const id = decodeURIComponent(path.split('/')[3]);
      const { WatcherStore } = await import('../watchers/store.js');
      new WatcherStore().delete(id);
      json(res, { success: true });
    },
  },

  // POST /api/memories
  {
    method: 'POST',
    test: exactPath('/api/memories'),
    handler: async ({ req, res }) => {
      const body = await readBody(req, res);
      if (body === null) return;
      let parsed: CreateMemoryBody;
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, { error: 'Invalid JSON' }, 400);
        return;
      }
      if (!parsed.content) {
        json(res, { error: 'Missing content' }, 400);
        return;
      }
      const { MemoryStore } = await import('../session/memory-store.js');
      MemoryStore.add(parsed.content, { tabName: parsed.tabName });
      json(res, { success: true });
    },
  },

  // DELETE /api/memories/:id
  {
    method: 'DELETE',
    test: regexPath(/^\/api\/memories\/\d+$/),
    handler: async ({ res, path }) => {
      const id = path.split('/')[3];
      const { MemoryStore } = await import('../session/memory-store.js');
      MemoryStore.delete(id);
      json(res, { success: true });
    },
  },

  // GET /api/media/config
  {
    method: 'GET',
    test: exactPath('/api/media/config'),
    handler: async ({ res }) => {
      const { getConfig } = await import('../config.js');
      const generators = getConfig().mediaGenerators || [];
      json(res, {
        generators: generators.map((g) => ({
          provider: g.provider,
          model: g.model,
          configured: !!g.apiKey,
        })),
      });
    },
  },

  // GET /api/channels/config
  {
    method: 'GET',
    test: exactPath('/api/channels/config'),
    handler: async ({ res }) => {
      const { getConfig } = await import('../config.js');
      const config = getConfig();
      json(res, {
        telegram: { configured: !!config.telegram?.token, botUsername: null as string | null },
        discord: { configured: !!config.discord?.token },
        whatsapp: { configured: !!config.whatsapp?.enabled },
        webhook: { configured: !!config.webhook?.enabled, port: config.webhook?.port },
      });
    },
  },

  // POST /api/computer-use
  {
    method: 'POST',
    test: exactPath('/api/computer-use'),
    handler: async ({ req, res }) => {
      const body = await readBody(req, res);
      if (body === null) return;
      let parsed: ComputerUseBody;
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, { error: 'Invalid JSON' }, 400);
        return;
      }
      const { getConfig, saveConfig } = await import('../config.js');
      const config = getConfig();
      config.claudeCode.computerUse = !!parsed.enabled;
      saveConfig(config);
      json(res, { enabled: !!parsed.enabled, message: 'Restart daemon to apply.' });
    },
  },

  // GET /api/computer-use
  {
    method: 'GET',
    test: exactPath('/api/computer-use'),
    handler: async ({ res }) => {
      const { getConfig } = await import('../config.js');
      json(res, { enabled: !!getConfig().claudeCode.computerUse });
    },
  },

  // GET /api/timeline
  {
    method: 'GET',
    test: exactPath('/api/timeline'),
    handler: async ({ res, url }) => {
      const { getTimeline } = await import('../timeline/index.js');
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const limit = parseIntParam(url.searchParams.get('limit'), 50, 200);
      json(res, { events: getTimeline({ date, limit }) });
    },
  },

  // GET /api/status
  {
    method: 'GET',
    test: exactPath('/api/status'),
    handler: ({ res }) => {
      const db = getDb();
      const activeTasks = (
        db.prepare('SELECT COUNT(*) as c FROM tasks WHERE enabled = 1').get() as { c: number }
      ).c;
      json(res, {
        version: VERSION,
        daemonPid: getDaemonPid(),
        tabs: TabStore.countAll(),
        activeTabs: TabStore.countRunning(),
        tasks: activeTasks,
        // Legacy alias — HTML reads either key; can be dropped after old dashboards have refreshed.
        cronJobs: activeTasks,
        memories: (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c,
      });
    },
  },

  // GET /api/tabs
  {
    method: 'GET',
    test: exactPath('/api/tabs'),
    handler: ({ res }) => {
      // Explicit column list — do NOT include session_id or system_prompt.
      // session_id is the credential used by `claude --resume`; leaking it via
      // /api/tabs (which any holder of the dashboard token can hit) would let
      // an attacker resume any tab's claude session locally.
      const tabs = getDb()
        .prepare(
          `
        SELECT t.id, t.name, t.status, t.working_dir, t.last_activity_at, t.created_at, t.pid,
          (SELECT COUNT(*) FROM messages WHERE tab_id = t.id) as message_count,
          (SELECT COALESCE(SUM(cost_usd), 0) FROM messages WHERE tab_id = t.id) as total_cost
        FROM tabs t ORDER BY t.last_activity_at DESC
      `,
        )
        .all();
      json(res, tabs);
    },
  },

  // GET /api/tabs/:name/messages
  {
    method: 'GET',
    test: regexPath(/^\/api\/tabs\/[^/]+\/messages$/),
    handler: ({ res, url, path }) => {
      const tabName = decodeURIComponent(path.split('/')[3]);
      const limit = parseIntParam(url.searchParams.get('limit'), 50, 200);
      const offset = parseIntParam(url.searchParams.get('offset'), 0, 100000);
      const tabId = TabStore.getIdByName(tabName);
      if (!tabId) {
        json(res, { error: 'Tab not found' }, 404);
        return;
      }
      const db = getDb();
      const messages = db
        .prepare(
          'SELECT role, content, cost_usd, tokens_in, tokens_out, created_at FROM messages WHERE tab_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        )
        .all(tabId, limit, offset) as Array<Record<string, unknown>>;
      const total = (
        db.prepare('SELECT COUNT(*) as c FROM messages WHERE tab_id = ?').get(tabId) as {
          c: number;
        }
      ).c;
      json(res, { messages: messages.reverse(), total, limit, offset });
    },
  },

  // GET /api/memories
  {
    method: 'GET',
    test: exactPath('/api/memories'),
    handler: async ({ res, url }) => {
      const limit = parseIntParam(url.searchParams.get('limit'), 50, 200);
      const offset = parseIntParam(url.searchParams.get('offset'), 0, 100000);
      const q = url.searchParams.get('q') || '';
      const { MemoryStore } = await import('../session/memory-store.js');
      const { memories: rows, total } = MemoryStore.list({ limit, offset, query: q || undefined });
      // Dashboard HTML reads snake_case (tab_name, created_at) — map back here
      // rather than reshape the store's typed return.
      const memories = rows.map((m) => ({
        id: m.id,
        content: m.content,
        tab_name: m.tabName,
        source: m.source,
        created_at: m.createdAt,
      }));
      json(res, { memories, total, limit, offset });
    },
  },

  // GET /api/tasks or /api/crons
  {
    method: 'GET',
    test: (path) => path === '/api/tasks' || path === '/api/crons',
    handler: ({ res, url }) => {
      const limit = parseIntParam(url.searchParams.get('limit'), 100, 500);
      const tasks = getDb().prepare('SELECT * FROM tasks ORDER BY created_at LIMIT ?').all(limit);
      json(res, tasks);
    },
  },

  // GET /api/costs
  {
    method: 'GET',
    test: exactPath('/api/costs'),
    handler: ({ res }) => {
      const costs = getDb()
        .prepare(
          `
        SELECT date(created_at) as day,
               SUM(cost_usd) as total_cost,
               COUNT(*) as message_count
        FROM messages
        WHERE role = 'assistant' AND cost_usd > 0
          AND created_at > datetime('now', '-30 days')
        GROUP BY date(created_at)
        ORDER BY day
      `,
        )
        .all();
      json(res, costs);
    },
  },

  // GET /api/update/status
  {
    method: 'GET',
    test: exactPath('/api/update/status'),
    handler: async ({ res }) => {
      async function npmViewLatest(name: string): Promise<string | null> {
        try {
          const { stdout } = await execFileAsync('npm', ['view', name, 'version'], {
            timeout: 10000,
          });
          return stdout.trim();
        } catch {
          return null;
        }
      }
      const packages = await Promise.all([
        (async () => {
          const p: Record<string, unknown> = {
            name: 'beecork-pipe',
            installed: VERSION,
            latest: await npmViewLatest('beecork-pipe'),
          };
          p.updateAvailable = !!(p.latest && p.installed !== p.latest);
          return p;
        })(),
        (async () => {
          const p: Record<string, unknown> = { name: '@anthropic-ai/claude-code' };
          try {
            const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 10000 });
            p.installed = stdout.trim().replace(/^.*?(\d+\.\d+\.\d+).*$/, '$1');
          } catch {
            p.installed = null;
          }
          p.latest = await npmViewLatest('@anthropic-ai/claude-code');
          p.updateAvailable = !!(p.installed && p.latest && p.installed !== p.latest);
          return p;
        })(),
      ]);
      json(res, { packages });
    },
  },

  // POST /api/update/:pkg
  {
    method: 'POST',
    test: regexPath(/^\/api\/update\/[^/]+$/),
    handler: async ({ res, path }) => {
      const pkgName = decodeURIComponent(path.split('/')[3]);
      const allowedPackages = new Set(['beecork-pipe', '@anthropic-ai/claude-code']);
      if (!allowedPackages.has(pkgName)) {
        json(res, { error: `Package "${pkgName}" is not in the allowed update list.` }, 400);
        return;
      }
      // Defense-in-depth: even though pkgName is allowlisted, validate against the
      // same regex used elsewhere so a typo in the allowlist can't widen the surface.
      if (!SAFE_NPM_PACKAGE.test(pkgName)) {
        json(res, { error: `Invalid package name: ${pkgName}` }, 400);
        return;
      }
      try {
        const { stdout } = await execFileAsync('npm', ['install', '-g', `${pkgName}@latest`], {
          timeout: 120000,
        });
        json(res, { success: true, package: pkgName, output: stdout.trim() });
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
    },
  },

  // GET /api/capabilities
  {
    method: 'GET',
    test: exactPath('/api/capabilities'),
    handler: async ({ res }) => {
      const { getAvailablePacks, isEnabled } = await import('../capabilities/index.js');
      const packs = getAvailablePacks().map((p) => ({
        ...p,
        enabled: isEnabled(p.id),
        mcpServer: { package: p.mcpServer.package },
      }));
      json(res, { packs });
    },
  },

  // POST /api/capabilities/:id/enable
  {
    method: 'POST',
    test: regexPath(/^\/api\/capabilities\/[^/]+\/enable$/),
    handler: async ({ req, res, path }) => {
      const packId = path.split('/')[3];
      const body = await readBody(req, res);
      if (body === null) return;
      let parsed: EnableCapBody;
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, { error: 'Invalid JSON' }, 400);
        return;
      }
      const { enablePack } = await import('../capabilities/index.js');
      try {
        enablePack(packId, parsed.apiKey);
        json(res, { success: true, message: 'Restart daemon to activate.' });
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  },

  // POST /api/capabilities/:id/disable
  {
    method: 'POST',
    test: regexPath(/^\/api\/capabilities\/[^/]+\/disable$/),
    handler: async ({ res, path }) => {
      const packId = path.split('/')[3];
      const { disablePack } = await import('../capabilities/index.js');
      disablePack(packId);
      json(res, { success: true });
    },
  },
];

export function dispatch(method: string, path: string): RouteEntry | null {
  for (const r of ROUTES) {
    if (r.method === method && r.test(path)) return r;
  }
  return null;
}

export { json };

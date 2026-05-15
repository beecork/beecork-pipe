// MCP tool handlers. Each handler returns the MCP response shape (or isError).
// Pulled out of server.ts so the dispatcher there can stay thin and so each
// handler is independently grep-able / testable.

import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expandHome } from '../util/paths.js';
import { getConfig, validateTabNameOrDefault } from '../config.js';
import { createTabRecord } from '../db/index.js';
import { MESSAGE_LIMITS } from '../util/text.js';
import { TabStore } from '../session/tab-store.js';

export function ok(text: string) { return { content: [{ type: 'text' as const, text }] }; }
export function fail(text: string) { return { content: [{ type: 'text' as const, text }], isError: true as const }; }
/**
 * Convenience wrapper for tools that return structured data — emits pretty-printed
 * JSON inside the standard `text` content. Use for endpoints whose responses are
 * meant to be parsed programmatically (channels, handoff, export_data). Use plain
 * ok() for human-readable lists/summaries.
 */
export function jsonOk(data: unknown) { return ok(JSON.stringify(data, null, 2)); }

export interface ToolContext {
  db: Database.Database;
  signalCronReload(): void;
  signalWatcherReload(): void;
  getGenerators(): Promise<import('../media/types.js').MediaGenerator[]>;
}

const MAX_CONTENT_LENGTH = MESSAGE_LIMITS.MCP_CONTENT;
const MAX_NAME_LENGTH = 256;
const VALID_SCHEDULE_TYPES = ['at', 'every', 'cron'];

type ToolResponse = ReturnType<typeof ok> | ReturnType<typeof fail>;
type ToolArgs = Record<string, unknown> | undefined;
type Handler = (ctx: ToolContext, args: ToolArgs) => Promise<ToolResponse> | ToolResponse;

async function handleMediaGeneration(ctx: ToolContext, mediaType: 'image' | 'video' | 'audio', args: ToolArgs): Promise<ToolResponse> {
  const { prompt, style, duration, provider } = (args || {}) as { prompt: string; style?: string; duration?: number; provider?: string };
  if (!prompt) return fail('Missing prompt');
  const generators = await ctx.getGenerators();
  const gen = provider
    ? generators.find(g => g.id === provider)
    : generators.find(g => g.supportedTypes.includes(mediaType));
  if (!gen) return fail(`No ${mediaType} generator configured. Run: beecork media`);
  try {
    const result = await gen.generate(mediaType, prompt, { style, duration });
    ctx.db.prepare('INSERT INTO pending_messages (tab_name, message, type) VALUES (?, ?, ?)').run(
      'default', JSON.stringify({ type: 'media', filePath: result.filePath, caption: prompt.slice(0, 200) }), 'media'
    );
    return ok(`Generated ${mediaType}: ${result.filePath}`);
  } catch (err) {
    return fail(`${mediaType} generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const HANDLERS: Record<string, Handler> = {
  beecork_remember: async (ctx, args) => {
    const { content, scope, category } = (args || {}) as { content: string; scope?: string; category?: string };
    if (!content || content.length > MAX_CONTENT_LENGTH) {
      return fail(`Content is required and must be under ${MAX_CONTENT_LENGTH} characters.`);
    }
    if (scope && scope !== 'tab' && scope !== 'auto') {
      const { addKnowledge } = await import('../knowledge/index.js');
      const currentTab = TabStore.mostRecent(ctx.db);
      addKnowledge(content, scope as 'global' | 'project', { category, projectPath: currentTab?.workingDir, tabName: undefined });
      return ok(`Remembered (${scope}): ${content.slice(0, 100)}`);
    }
    const fullContent = category ? `[${category}] ${content}` : content;
    const existing = ctx.db.prepare(
      'SELECT id FROM memories WHERE content = ? AND tab_name IS NULL LIMIT 1'
    ).get(fullContent) as { id: number } | undefined;
    if (existing) return ok(`Already remembered: "${fullContent}"`);
    ctx.db.prepare('INSERT INTO memories (content, source) VALUES (?, ?)').run(fullContent, 'tool');
    return ok(`Remembered: "${fullContent}"`);
  },

  beecork_task_create: async (ctx, args) => {
    const { name: jobName, scheduleType, schedule, message, tabName } = (args || {}) as {
      name: string; scheduleType: string; schedule: string; message: string; tabName?: string;
    };
    if (!jobName || jobName.length > MAX_NAME_LENGTH) {
      return fail(`Task name is required and must be under ${MAX_NAME_LENGTH} characters.`);
    }
    if (!VALID_SCHEDULE_TYPES.includes(scheduleType)) {
      return fail(`Invalid scheduleType "${scheduleType}". Must be one of: ${VALID_SCHEDULE_TYPES.join(', ')}`);
    }
    if (!message || message.length > MAX_CONTENT_LENGTH) {
      return fail(`Message is required and must be under ${MAX_CONTENT_LENGTH} characters.`);
    }
    const id = uuidv4();
    const tab = tabName || 'default';
    const tabError = validateTabNameOrDefault(tab);
    if (tabError) return fail(tabError);
    // Validate schedule expression up-front so misconfigured tasks fail loud instead of silently never firing.
    const { validateSchedule } = await import('../tasks/scheduler.js');
    const scheduleErr = validateSchedule(scheduleType, schedule);
    if (scheduleErr) return fail(scheduleErr);
    ctx.db.prepare(
      `INSERT INTO tasks (id, name, schedule_type, schedule, tab_name, message, payload_type, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'agentTurn', 1, ?)`
    ).run(id, jobName, scheduleType, schedule, tab, message, new Date().toISOString());
    try { ctx.signalCronReload(); } catch (err) {
      return ok(`Task created: "${jobName}" (${scheduleType}: ${schedule}) -> tab:${tab}\nID: ${id}\nWARN: signal-reload failed (${err instanceof Error ? err.message : String(err)}); restart daemon to schedule.`);
    }
    return ok(`Task created: "${jobName}" (${scheduleType}: ${schedule}) -> tab:${tab}\nID: ${id}`);
  },

  beecork_task_list: async (ctx) => {
    const jobs = ctx.db.prepare('SELECT * FROM tasks ORDER BY created_at LIMIT 500').all() as Array<Record<string, unknown>>;
    if (jobs.length === 0) return ok('No tasks scheduled.');
    const lines = jobs.map(j =>
      `- ${j.name} [${j.enabled ? 'enabled' : 'disabled'}] (${j.schedule_type}: ${j.schedule}) -> tab:${j.tab_name} (ID: ${j.id})`
    );
    return ok(lines.join('\n'));
  },

  beecork_task_delete: async (ctx, args) => {
    const { id } = (args || {}) as { id: string };
    const result = ctx.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    if (result.changes === 0) return ok(`No task found with ID: ${id}`);
    try { ctx.signalCronReload(); } catch { /* daemon picks up on restart */ }
    return ok(`Deleted task: ${id}`);
  },

  beecork_watch_create: async (ctx, args) => {
    const {
      name: watchName, description: watchDesc, checkCommand, condition,
      action, actionDetails, schedule: watchSchedule,
    } = (args || {}) as {
      name: string; description?: string; checkCommand: string; condition: string;
      action?: string; actionDetails?: string; schedule: string;
    };
    if (!watchName || watchName.length > MAX_NAME_LENGTH) {
      return fail(`Watcher name is required and must be under ${MAX_NAME_LENGTH} characters.`);
    }
    if (!checkCommand) return fail('checkCommand is required.');
    if (!condition) return fail('condition is required.');
    if (!watchSchedule) return fail('schedule is required.');
    // Schedule validation: watchers use "cron" or interval like "5m". Try both.
    const { validateSchedule } = await import('../tasks/scheduler.js');
    const cronErr = validateSchedule('cron', watchSchedule);
    const intervalErr = validateSchedule('every', watchSchedule);
    if (cronErr && intervalErr) return fail(`Invalid schedule "${watchSchedule}" — must be a cron expression or interval like "5m"/"1h"/"1d".`);
    const watchId = uuidv4();
    ctx.db.prepare(
      `INSERT INTO watchers (id, name, description, check_command, condition, action, action_details, schedule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(watchId, watchName, watchDesc || null, checkCommand, condition, action || 'notify', actionDetails || null, watchSchedule);
    try { ctx.signalWatcherReload(); } catch (err) {
      return ok(`Watcher created: "${watchName}" (${watchSchedule})\nID: ${watchId}\nWARN: signal-reload failed (${err instanceof Error ? err.message : String(err)}); restart daemon to schedule.`);
    }
    return ok(`Watcher created: "${watchName}" (${watchSchedule})\nID: ${watchId}`);
  },

  beecork_watch_list: async (ctx) => {
    const watchers = ctx.db.prepare('SELECT * FROM watchers ORDER BY created_at LIMIT 500').all() as Array<Record<string, unknown>>;
    if (watchers.length === 0) return ok('No watchers configured.');
    const watchLines = watchers.map(w =>
      `- ${w.name} [${w.enabled ? 'enabled' : 'disabled'}] ${w.schedule} | action: ${w.action} | triggers: ${w.trigger_count} (ID: ${w.id})`
    );
    return ok(watchLines.join('\n'));
  },

  beecork_watch_delete: async (ctx, args) => {
    const { id: watchDelId } = (args || {}) as { id: string };
    const watchDelResult = ctx.db.prepare('DELETE FROM watchers WHERE id = ?').run(watchDelId);
    if (watchDelResult.changes === 0) return ok(`No watcher found with ID: ${watchDelId}`);
    try { ctx.signalWatcherReload(); } catch { /* daemon picks up on restart */ }
    return ok(`Deleted watcher: ${watchDelId}`);
  },

  beecork_tab_create: async (ctx, args) => {
    const { name: tabName, workingDir, template: templateName, systemPrompt } = (args || {}) as {
      name: string; workingDir?: string; template?: string; systemPrompt?: string;
    };
    if (!tabName) return fail('Tab name is required.');
    // tab create does NOT allow "default" — that tab is auto-managed by the daemon.
    const { validateTabName } = await import('../config.js');
    const tabCreateError = validateTabName(tabName);
    if (tabCreateError) return fail(tabCreateError);
    const config = getConfig();
    const template = templateName ? config.tabTemplates?.[templateName] : undefined;
    if (templateName && !template) {
      return fail(`Template "${templateName}" not found. Available: ${Object.keys(config.tabTemplates || {}).join(', ') || 'none'}`);
    }
    const dirInput = workingDir || template?.workingDir || os.homedir();
    const dir = path.resolve(expandHome(dirInput));
    const tabSystemPrompt = systemPrompt || template?.systemPrompt || null;
    try {
      // createTabRecord validates existence + isDirectory and throws on failure.
      const result = createTabRecord(ctx.db, { name: tabName, workingDir: dir, systemPrompt: tabSystemPrompt });
      if (!result.created) return ok(`Tab "${tabName}" already exists.`);
      const parts = [`Created tab: "${tabName}" (working dir: ${dir})`];
      if (tabSystemPrompt) parts.push(`System prompt: "${tabSystemPrompt.slice(0, 100)}${tabSystemPrompt.length > 100 ? '...' : ''}"`);
      if (templateName) parts.push(`Template: ${templateName}`);
      return ok(parts.join('\n'));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },

  beecork_tab_list: async (ctx) => {
    const tabs = TabStore.listAll(ctx.db);
    if (tabs.length === 0) return ok('No tabs.');
    const lines = tabs.map(t => `- ${t.name} [${t.status}] dir:${t.workingDir} last:${t.lastActivityAt}`);
    return ok(lines.join('\n'));
  },

  beecork_send_message: async (ctx, args) => {
    const { tabName, message } = (args || {}) as { tabName: string; message: string };
    if (!tabName || !message) return fail('Both tabName and message are required.');
    const sendTabError = validateTabNameOrDefault(tabName);
    if (sendTabError) return fail(sendTabError);
    if (message.length > MAX_CONTENT_LENGTH) {
      return fail(`Message must be under ${MAX_CONTENT_LENGTH} characters.`);
    }
    ctx.db.prepare('INSERT INTO pending_messages (tab_name, message) VALUES (?, ?)').run(tabName, message);
    return ok(`Message queued for tab "${tabName}".`);
  },

  beecork_recall: async (ctx, args) => {
    const { query, limit } = (args || {}) as { query: string; limit?: number };
    const maxResults = Math.min(limit ?? 10, 50);
    const memories = ctx.db.prepare(
      'SELECT content, tab_name, source, created_at FROM memories WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?'
    ).all(`%${query}%`, maxResults) as Array<{ content: string; tab_name: string | null; source: string; created_at: string }>;
    const { searchKnowledge } = await import('../knowledge/index.js');
    const knowledgeResults = searchKnowledge(query);
    const allResults = [
      ...knowledgeResults.map(k => k.content),
      ...memories.map(m => m.content),
    ];
    if (allResults.length === 0) return ok(`No relevant knowledge found matching "${query}".`);
    return ok(allResults.join('\n---\n'));
  },

  beecork_notify: async (ctx, args) => {
    const { message, urgent } = (args || {}) as { message: string; urgent?: boolean };
    if (!message) return fail('Message is required.');
    const prefix = urgent ? '🚨 ' : '';
    ctx.db.prepare("INSERT INTO pending_messages (tab_name, message, type) VALUES ('_notify', ?, 'notification')").run(prefix + message);
    return ok('Notification sent to user.');
  },

  beecork_status: async (ctx) => {
    const tabCount = TabStore.countAll(ctx.db);
    const activeTabs = TabStore.countRunning(ctx.db);
    const taskCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM tasks WHERE enabled = 1').get() as { c: number }).c;
    const watcherCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM watchers WHERE enabled = 1').get() as { c: number }).c;
    const memoryCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    return ok([
      `Tabs: ${tabCount} total, ${activeTabs} running`,
      `Tasks: ${taskCount} active`,
      `Watchers: ${watcherCount} active`,
      `Memories: ${memoryCount} stored`,
    ].join('\n'));
  },

  beecork_send_media: async (ctx, args) => {
    const { filePath, caption, tabName } = (args || {}) as { filePath: string; caption?: string; tabName?: string };
    if (!fs.existsSync(filePath)) return fail(`File not found: ${filePath}`);
    const tab = tabName || 'default';
    ctx.db.prepare(
      'INSERT INTO pending_messages (tab_name, message, type) VALUES (?, ?, ?)'
    ).run(tab, JSON.stringify({ type: 'media', filePath, caption }), 'media');
    return ok(`Media queued for sending: ${filePath}`);
  },

  beecork_channels: async () => {
    const config = getConfig();
    const channels: Array<{ id: string; name: string; streaming: boolean; media: boolean }> = [];
    if (config.telegram?.token) channels.push({ id: 'telegram', name: 'Telegram', streaming: true, media: true });
    if (config.whatsapp?.enabled) channels.push({ id: 'whatsapp', name: 'WhatsApp', streaming: false, media: true });
    if (config.webhook?.enabled) channels.push({ id: 'webhook', name: 'Webhook', streaming: false, media: false });
    if (config.discord?.token) channels.push({ id: 'discord', name: 'Discord', streaming: false, media: true });
    return jsonOk(channels);
  },

  beecork_cost: async (_ctx, args) => {
    const { tabName } = (args || {}) as { tabName?: string };
    const { getCostSummary, formatCostSummary } = await import('../observability/analytics.js');
    const summary = getCostSummary();
    if (tabName) {
      const tab = summary.perTab.find(t => t.name === tabName);
      if (!tab) return fail(`Tab "${tabName}" not found`);
      return ok(`Tab "${tabName}": $${tab.cost.toFixed(4)} (${tab.messages} messages)`);
    }
    return ok(formatCostSummary(summary));
  },

  beecork_failed_deliveries: async (ctx) => {
    const failed = ctx.db.prepare(
      "SELECT m.content, m.created_at, m.retry_count, t.name as tab_name FROM messages m JOIN tabs t ON t.id = m.tab_id WHERE m.delivery_status = 'failed' ORDER BY m.created_at DESC LIMIT 20"
    ).all() as Array<{ content: string; created_at: string; retry_count: number; tab_name: string }>;
    if (failed.length === 0) return ok('No failed deliveries.');
    const lines = failed.map(f => `[${f.created_at}] tab:${f.tab_name} retries:${f.retry_count}\n  ${f.content.slice(0, 200)}`);
    return ok(lines.join('\n\n'));
  },

  beecork_activity: async (_ctx, args) => {
    const hours = ((args || {}) as { hours?: number }).hours || 24;
    const { getActivitySummary, formatActivitySummary } = await import('../observability/analytics.js');
    return ok(formatActivitySummary(getActivitySummary(hours)));
  },

  beecork_export_data: async (ctx, args) => {
    const { type: dataType, days = 30 } = (args || {}) as { type: string; days?: number };
    const since = new Date(Date.now() - days * 86400000).toISOString();
    let data: unknown;
    switch (dataType) {
      case 'costs':
        data = ctx.db.prepare(
          "SELECT date(created_at) as day, SUM(cost_usd) as cost, COUNT(*) as messages FROM messages WHERE role = 'assistant' AND created_at > ? GROUP BY date(created_at) ORDER BY day"
        ).all(since);
        break;
      case 'messages':
        data = ctx.db.prepare(
          "SELECT m.role, m.content, m.cost_usd, m.created_at, t.name as tab FROM messages m JOIN tabs t ON t.id = m.tab_id WHERE m.created_at > ? ORDER BY m.created_at DESC LIMIT 500"
        ).all(since);
        break;
      case 'crons':
        data = ctx.db.prepare('SELECT * FROM tasks ORDER BY created_at').all();
        break;
      default:
        return fail('Invalid type. Use: costs, messages, or crons');
    }
    return jsonOk(data);
  },

  beecork_handoff: async (ctx, args) => {
    const { tabName } = (args || {}) as { tabName: string };
    const tab = TabStore.findByName(tabName, ctx.db);
    if (!tab) return fail(`Tab "${tabName}" not found`);
    const messages = ctx.db.prepare(
      'SELECT role, content FROM messages WHERE tab_id = ? ORDER BY created_at DESC LIMIT 5'
    ).all(tab.id) as Array<{ role: string; content: string }>;
    const info = {
      sessionId: tab.sessionId,
      workingDir: tab.workingDir,
      status: tab.status,
      resumeCommand: `beecork attach ${tabName}`,
      manualCommand: `cd ${tab.workingDir} && claude --session-id ${tab.sessionId} --resume`,
      recentMessages: messages.reverse().map(m => ({ role: m.role, preview: m.content.slice(0, 200) })),
    };
    return jsonOk(info);
  },

  beecork_delegate: async (ctx, args) => {
    const { tabName, message, returnToTab } = (args || {}) as { tabName: string; message: string; returnToTab?: string };
    try {
      const { createDelegation } = await import('../delegation/manager.js');
      const delegation = createDelegation(returnToTab || 'default', tabName, message, returnToTab);
      ctx.db.prepare('INSERT INTO pending_messages (tab_name, message, type) VALUES (?, ?, ?)').run(tabName, message, 'delegation');
      return ok(`Delegated to tab "${tabName}". Result will be sent back to "${delegation.returnToTab}" when complete.\n\nDelegation ID: ${delegation.id}`);
    } catch (err) {
      return fail(`Delegation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  beecork_delegation_status: async (_ctx, args) => {
    const { tabName } = (args || {}) as { tabName?: string };
    const { getPendingDelegations } = await import('../delegation/manager.js');
    const delegations = getPendingDelegations(tabName);
    if (delegations.length === 0) return ok('No pending delegations.');
    const lines = delegations.map(d => `${d.sourceTab} → ${d.targetTab} [${d.status}] (depth ${d.depth})\n  "${d.message.slice(0, 100)}"`);
    return ok(lines.join('\n\n'));
  },

  beecork_project_create: async (_ctx, args) => {
    const { name, path: customPath } = (args || {}) as { name: string; path?: string };
    try {
      const { createProject } = await import('../projects/index.js');
      const project = createProject(name, customPath);
      return ok(`Folder "${name}" registered at ${project.path}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },

  beecork_project_list: async () => {
    const { listProjects } = await import('../projects/index.js');
    const projects = listProjects();
    if (projects.length === 0) return ok('No folders discovered. Create one with beecork_project_create.');
    const lines = projects.map(p => `${p.type === 'category' ? '📁' : '📦'} ${p.name} — ${p.path}`);
    return ok(lines.join('\n'));
  },

  beecork_close_tab: async (ctx, args) => {
    const { tabName } = (args || {}) as { tabName: string };
    // Mark tab stopped so the daemon's recovery loop cleans up the subprocess.
    // MCP server is a child of `claude` and has no TabManager; we can only mutate the DB.
    TabStore.markRunningAsStopped(tabName, ctx.db);
    const deleted = TabStore.deleteWithMessages(tabName, ctx.db);
    if (!deleted) return fail(`Tab "${tabName}" not found.`);
    return ok(`Tab "${tabName}" permanently closed.`);
  },

  beecork_generate_image: (ctx, args) => handleMediaGeneration(ctx, 'image', args),
  beecork_generate_video: (ctx, args) => handleMediaGeneration(ctx, 'video', args),
  beecork_generate_audio: (ctx, args) => handleMediaGeneration(ctx, 'audio', args),

  beecork_media_providers: async (ctx) => {
    const generators = await ctx.getGenerators();
    if (generators.length === 0) return ok('No media generators configured. Add mediaGenerators to config.json.');
    const lines = generators.map(g => `- ${g.name} (${g.id}): ${g.supportedTypes.join(', ')}`);
    return ok(lines.join('\n'));
  },

  beecork_knowledge: async (ctx, args) => {
    const { scope: knowledgeScope } = (args || {}) as { scope?: string };
    const { getGlobalKnowledge, getProjectKnowledge, getTabKnowledge, getAllKnowledge, formatKnowledgeForContext } = await import('../knowledge/index.js');
    let entries;
    if (knowledgeScope === 'global') {
      entries = getGlobalKnowledge();
    } else if (knowledgeScope === 'project') {
      const currentTab = TabStore.mostRecent(ctx.db);
      entries = currentTab ? getProjectKnowledge(currentTab.workingDir) : [];
    } else if (knowledgeScope === 'tab') {
      const currentTab = TabStore.mostRecent(ctx.db);
      entries = currentTab ? getTabKnowledge(currentTab.name) : [];
    } else {
      entries = getAllKnowledge();
    }
    if (entries.length === 0) return ok('No knowledge stored yet.');
    return ok(formatKnowledgeForContext(entries));
  },

  beecork_capabilities: async () => {
    const { getAvailablePacks, isEnabled } = await import('../capabilities/index.js');
    const packs = getAvailablePacks();
    const lines = packs.map(p => `${isEnabled(p.id) ? '✓ enabled' : '○ available'} | ${p.id} — ${p.name}: ${p.description}`);
    return ok(lines.join('\n'));
  },

  beecork_history: async (_ctx, args) => {
    const { date, tabName, limit } = (args || {}) as { date?: string; tabName?: string; limit?: number };
    const { getTimeline, formatTimeline } = await import('../timeline/index.js');
    const events = getTimeline({ date: date || new Date().toISOString().slice(0, 10), tabName, limit });
    return ok(formatTimeline(events));
  },

  beecork_replay: async (ctx, args) => {
    const { eventId } = (args || {}) as { eventId: string };
    const { getReplayInfo } = await import('../timeline/index.js');
    const info = getReplayInfo(eventId);
    if (!info) return fail('Event not found or not replayable.');
    ctx.db.prepare('INSERT INTO pending_messages (tab_name, message, type) VALUES (?, ?, ?)').run(info.tabName, info.message, 'replay');
    return ok(`Replaying in tab "${info.tabName}": ${info.message.slice(0, 200)}`);
  },

  beecork_store_search: async (_ctx, args) => {
    const { query } = (args || {}) as { query: string };
    try {
      const response = await fetch(`https://registry.npmjs.org/-/v1/search?text=beecork+${encodeURIComponent(query)}&size=10`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return fail('npm registry search failed');
      const data = await response.json() as { objects?: Array<{ package: { name: string; version: string; description?: string } }> };
      const packages = (data.objects || []).filter(o => o.package.name.startsWith('beecork-'));
      if (packages.length === 0) return ok(`No beecork packages found for "${query}". You can create one with: beecork channel create <name> or beecork media create <name>`);
      const lines = packages.map(o => `${o.package.name}@${o.package.version} — ${o.package.description || 'No description'}`);
      return ok(`${packages.length} package(s):\n${lines.join('\n')}\n\nInstall: npm install -g <package-name>`);
    } catch {
      return fail('Failed to search npm registry');
    }
  },
};

// Aliases retained for backward compatibility with older Claude sessions that cached
// the cron_* tool names. These dispatch to the same handlers as their task_* counterparts.
HANDLERS.beecork_cron_create = HANDLERS.beecork_task_create;
HANDLERS.beecork_cron_list = HANDLERS.beecork_task_list;
HANDLERS.beecork_cron_delete = HANDLERS.beecork_task_delete;

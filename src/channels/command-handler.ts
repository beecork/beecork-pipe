/**
 * Shared command handler for all channels.
 * Extracts command logic so it's defined once and called from Telegram, WhatsApp, Discord, etc.
 */
import { timeAgo } from '../util/text.js';
import { validateTabName } from '../config.js';
import { exportTab, formatHandoffInfo } from '../session/handoff.js';
import { logActivity } from '../timeline/index.js';
import type { TabManager } from '../session/manager.js';
import type { Project } from '../projects/types.js';

interface WatcherRow {
  name: string;
  enabled: number;
  schedule: string;
  trigger_count: number;
}

interface TaskRow {
  name: string;
  enabled: number;
  schedule_type: string;
  schedule: string;
  tab_name: string;
}

export interface CommandContext {
  userId: string;
  text: string;
  isAdmin: boolean;
  channelId: string;
}

export interface CommandResult {
  handled: boolean;
  response?: string;
}

// RouteResult and resolveProjectRoute moved to src/projects/router.ts (re-exported
// via src/projects/index.ts) so all routing logic lives in one module.
export type { RouteResult } from '../projects/router.js';

/**
 * Handle shared commands that work identically across all channels.
 * Returns { handled: true, response } if a command was matched.
 * The channel is responsible for sending the response via its own API.
 */
export async function handleSharedCommand(
  ctx: CommandContext,
  tabManager: TabManager,
): Promise<CommandResult> {
  const { text, userId, isAdmin } = ctx;

  // /tabs
  if (text === '/tabs' || text.startsWith('/tabs@')) {
    const tabs = tabManager.listTabs();
    if (tabs.length === 0) return { handled: true, response: 'No tabs.' };
    const list = tabs
      .map((t) => `• ${t.name} [${t.status}] — ${timeAgo(t.lastActivityAt)}`)
      .join('\n');
    return { handled: true, response: list };
  }

  // /stop <name>
  if (text.startsWith('/stop ')) {
    if (!isAdmin) return { handled: true, response: 'Only admin can stop tabs.' };
    const tabName = text.slice(6).trim();
    tabManager.stopTab(tabName);
    return { handled: true, response: `Stopped tab: ${tabName}` };
  }

  // /tab <name> --set-prompt "..."
  if (text.startsWith('/tab ')) {
    const rest = text.slice(5);
    const setPromptMatch = rest.match(/^(\S+)\s+--set-prompt\s+"([^"]+)"/);
    if (setPromptMatch) {
      if (!isAdmin) return { handled: true, response: 'Only admin can change system prompts.' };
      const tabName = setPromptMatch[1];
      if (tabName !== 'default') {
        const nameErr = validateTabName(tabName);
        if (nameErr) return { handled: true, response: `Invalid tab name: ${nameErr}` };
      }
      const systemPrompt = setPromptMatch[2];
      const updated = tabManager.setSystemPrompt(tabName, systemPrompt);
      return {
        handled: true,
        response: updated
          ? `System prompt updated for tab "${tabName}"`
          : `Tab "${tabName}" not found.`,
      };
    }

    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) {
      return { handled: true, response: 'Usage: /tab <name> <message>' };
    }
    const tabName = rest.slice(0, spaceIdx);
    const validationError = validateTabName(tabName);
    if (validationError) {
      return { handled: true, response: `Invalid tab name: ${validationError}` };
    }
    // /tab with a valid name + message — not handled here, falls through to message handling
    return { handled: false };
  }

  // /register, /link, /users were part of unused multi-user scaffolding —
  // removed in the audit fix pass. Beecork is single-user; admin is the first
  // allowedUserId on Telegram (or config.telegram.adminUserId).

  // /watches
  if (text === '/watches' || text.startsWith('/watches@')) {
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    const watchers = db.prepare('SELECT * FROM watchers ORDER BY created_at').all() as WatcherRow[];
    if (watchers.length === 0) return { handled: true, response: 'No watchers configured.' };
    const watchList = watchers
      .map((w) => {
        const status = w.enabled ? 'active' : 'disabled';
        return `[${status}] ${w.name} -- ${w.schedule} (triggers: ${w.trigger_count})`;
      })
      .join('\n');
    return { handled: true, response: `Watchers:\n${watchList}` };
  }

  // /tasks
  if (text === '/tasks' || text.startsWith('/tasks@')) {
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as TaskRow[];
    if (tasks.length === 0) return { handled: true, response: 'No tasks scheduled.' };
    const taskList = tasks
      .map((t) => {
        const status = t.enabled ? 'enabled' : 'disabled';
        return `[${status}] ${t.name} (${t.schedule_type}: ${t.schedule}) -> tab:${t.tab_name}`;
      })
      .join('\n');
    return { handled: true, response: `Tasks:\n${taskList}` };
  }

  // /cost
  if (text === '/cost' || text.startsWith('/cost ')) {
    const { getCostSummary, formatCostSummary } = await import('../observability/analytics.js');
    return { handled: true, response: formatCostSummary(getCostSummary()) };
  }

  // /activity [hours]
  if (text === '/activity' || text.startsWith('/activity ')) {
    const hours = parseInt(text.slice(10).trim()) || 24;
    const { getActivitySummary, formatActivitySummary } =
      await import('../observability/analytics.js');
    return { handled: true, response: formatActivitySummary(getActivitySummary(hours)) };
  }

  // /handoff [tab]
  if (text.startsWith('/handoff')) {
    const tabName = text.slice(9).trim() || 'default';
    const info = exportTab(tabName);
    if (!info) return { handled: true, response: `Tab "${tabName}" not found.` };
    logActivity('user_command', '/handoff', { tabName });
    return { handled: true, response: formatHandoffInfo(info) };
  }

  // /folders (also accept legacy /projects)
  if (
    text === '/folders' ||
    text === '/projects' ||
    text.startsWith('/folders@') ||
    text.startsWith('/projects@')
  ) {
    const { listProjects } = await import('../projects/index.js');
    const projects = listProjects();
    if (projects.length === 0)
      return { handled: true, response: 'No folders found. Create one with /newfolder <name>' };
    const userProjects = projects.filter((p): p is Project => p.type === 'user-project');
    const categories = projects.filter((p): p is Project => p.type === 'category');
    let msg = '📁 Folders:\n';
    if (userProjects.length > 0)
      msg += userProjects.map((p) => `  • ${p.name} — ${p.path}`).join('\n');
    if (categories.length > 0) {
      msg += '\n\n📂 Categories:\n';
      msg += categories.map((p) => `  • ${p.name}`).join('\n');
    }
    return { handled: true, response: msg };
  }

  // /folder <name> (also accept legacy /project <name>)
  if (
    (text.startsWith('/folder ') && !text.startsWith('/folders')) ||
    (text.startsWith('/project ') && !text.startsWith('/projects'))
  ) {
    const prefix = text.startsWith('/folder ') ? '/folder ' : '/project ';
    const name = text.slice(prefix.length).trim();
    const { getProject, setUserContext } = await import('../projects/index.js');
    const project = getProject(name);
    if (!project)
      return {
        handled: true,
        response: `Folder "${name}" not found. Use /folders to list or /newfolder to create.`,
      };
    setUserContext(userId, project.name, project.name);
    return {
      handled: true,
      response: `Switched to folder: ${project.name}\nPath: ${project.path}\n\nNext messages will work in this folder.`,
    };
  }

  // /newfolder <name> [path] (also accept legacy /newproject)
  if (text.startsWith('/newfolder ') || text.startsWith('/newproject ')) {
    const prefix = text.startsWith('/newfolder ') ? '/newfolder ' : '/newproject ';
    const parts = text.slice(prefix.length).trim().split(/\s+/);
    const name = parts[0];
    const customPath = parts[1] || undefined;
    if (!name) return { handled: true, response: 'Usage: /newfolder <name> [path]' };
    const { createProject, setUserContext } = await import('../projects/index.js');
    const project = createProject(name, customPath);
    setUserContext(userId, project.name, project.name);
    return {
      handled: true,
      response: `✓ Folder "${name}" created at ${project.path}\nSwitched to this folder.`,
    };
  }

  // /close <tab>
  if (text.startsWith('/close ')) {
    const tabNameToClose = text.slice(7).trim();
    if (!tabNameToClose) return { handled: true, response: 'Usage: /close <tabname>' };
    const closed = tabManager.closeTab(tabNameToClose);
    return {
      handled: true,
      response: closed
        ? `Tab "${tabNameToClose}" permanently closed. History deleted.`
        : `Tab "${tabNameToClose}" not found.`,
    };
  }

  // /fresh <folder>
  if (text.startsWith('/fresh ')) {
    const folderName = text.slice(7).trim();
    const { getProject, setUserContext } = await import('../projects/index.js');
    const project = getProject(folderName);
    if (!project) return { handled: true, response: `Folder "${folderName}" not found.` };
    const freshTabName = `${folderName}-${Date.now().toString(36).slice(-4)}`;
    setUserContext(userId, project.name, freshTabName);
    return {
      handled: true,
      response: `Fresh start in "${folderName}" (tab: ${freshTabName})\nSend your message now.`,
    };
  }

  // /history [date|yesterday]
  if (text === '/history' || text.startsWith('/history ')) {
    const dateArg = text.slice(9).trim();
    const { getTimeline, formatTimeline } = await import('../timeline/index.js');
    let date: string;
    if (dateArg === 'yesterday') {
      date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    } else if (dateArg) {
      date = dateArg;
    } else {
      date = new Date().toISOString().slice(0, 10);
    }
    const events = getTimeline({ date, limit: 30 });
    return { handled: true, response: formatTimeline(events) };
  }

  // /knowledge
  if (text === '/knowledge') {
    const { getAllKnowledge, formatKnowledgeForContext } = await import('../knowledge/index.js');
    const entries = getAllKnowledge();
    if (entries.length === 0) {
      return {
        handled: true,
        response: 'No knowledge stored yet. Beecork learns from your conversations.',
      };
    }
    return { handled: true, response: formatKnowledgeForContext(entries).slice(0, 4000) };
  }

  return { handled: false };
}

// resolveProjectRoute lives at src/projects/router.ts — re-exported here so
// existing callers (channels/pipeline.ts) don't need to update their import path.
export { resolveProjectRoute } from '../projects/router.js';

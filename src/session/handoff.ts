/**
 * Session handoff helpers — used by both the CLI (`beecork attach`) and the
 * shared command handler (`/handoff` from any channel).
 *
 * Moved here from `cli/handoff.ts` so daemon-shared code (channels, MCP) can
 * import without reaching into the CLI layer. The CLI-specific `attachTab`
 * (which spawns claude and calls process.exit) stays in `cli/handoff.ts`.
 */

import { getDb } from '../db/index.js';
import { TabStore } from './tab-store.js';

export interface TabHandoffInfo {
  name: string;
  sessionId: string;
  workingDir: string;
  status: string;
  lastActivity: string;
  recentMessages: Array<{ role: string; content: string }>;
}

export function exportTab(tabName: string): TabHandoffInfo | null {
  const tab = TabStore.findByName(tabName);
  if (!tab) return null;

  const messages = getDb()
    .prepare('SELECT role, content FROM messages WHERE tab_id = ? ORDER BY created_at DESC LIMIT 5')
    .all(tab.id) as Array<{ role: string; content: string }>;

  return {
    name: tab.name,
    sessionId: tab.sessionId,
    workingDir: tab.workingDir,
    status: tab.status,
    lastActivity: tab.lastActivityAt,
    recentMessages: messages.reverse(),
  };
}

export function formatHandoffInfo(info: TabHandoffInfo): string {
  const lines = [
    `Session Handoff — tab "${info.name}"`,
    '',
    `Session ID: ${info.sessionId}`,
    `Working dir: ${info.workingDir}`,
    `Status: ${info.status}`,
    `Last activity: ${info.lastActivity}`,
    '',
    'To resume in terminal:',
    `  beecork attach ${info.name}`,
    '',
    'Or manually:',
    `  cd ${info.workingDir}`,
    `  claude --session-id ${info.sessionId} --resume`,
  ];

  if (info.recentMessages.length > 0) {
    lines.push('', 'Recent context:');
    for (const msg of info.recentMessages) {
      lines.push(
        `  [${msg.role}] ${msg.content.slice(0, 150)}${msg.content.length > 150 ? '...' : ''}`,
      );
    }
  }

  return lines.join('\n');
}

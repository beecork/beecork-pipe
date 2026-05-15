#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import {
  getDbPath,
  getCronReloadSignalPath,
  getWatcherReloadSignalPath,
} from '../util/paths.js';
import { VERSION } from '../version.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';
import { HANDLERS, fail, type ToolContext } from './handlers.js';

// MCP server runs as a child of `claude`, not the Beecork daemon.
// It communicates with the daemon via shared SQLite + signal files.

// Path helpers from util/paths.ts so daemon + MCP child always agree on locations,
// including when BEECORK_HOME env is set for isolation/testing.
const DB_PATH = getDbPath();
const CRON_RELOAD_SIGNAL = getCronReloadSignalPath();
const WATCHER_RELOAD_SIGNAL = getWatcherReloadSignalPath();

// Cached singleton connection (lives for the MCP server's lifetime).
let cachedDb: Database.Database | null = null;
function getDb(): Database.Database {
  if (cachedDb) return cachedDb;
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  cachedDb = db;
  return db;
}
process.on('exit', () => { cachedDb?.close(); });

// Cached media generators (lazy singleton).
let cachedGenerators: import('../media/types.js').MediaGenerator[] | null = null;
async function getGenerators(): Promise<import('../media/types.js').MediaGenerator[]> {
  if (!cachedGenerators) {
    const { getConfig } = await import('../config.js');
    const { initMediaGenerators } = await import('../media/index.js');
    cachedGenerators = initMediaGenerators(getConfig().mediaGenerators);
  }
  return cachedGenerators;
}

function signalCronReload(): void {
  fs.writeFileSync(CRON_RELOAD_SIGNAL, String(Date.now()));
}
function signalWatcherReload(): void {
  fs.writeFileSync(WATCHER_RELOAD_SIGNAL, String(Date.now()));
}

const server = new Server(
  { name: 'beecork', version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLERS[name];
  if (!handler) return fail(`Unknown tool: ${name}`);
  try {
    const ctx: ToolContext = {
      db: getDb(),
      signalCronReload,
      signalWatcherReload,
      getGenerators,
    };
    return await handler(ctx, args as Record<string, unknown> | undefined);
  } catch (err) {
    return fail(`Beecork error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});

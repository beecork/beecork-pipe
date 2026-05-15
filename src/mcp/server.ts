#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { getDbPath, getCronReloadSignalPath, getWatcherReloadSignalPath } from '../util/paths.js';
import { openDb } from '../db/connection.js';
import { VERSION } from '../version.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';
import { HANDLERS, fail, type ToolContext } from './handlers.js';
import { validateToolArgs } from './validate.js';

// MCP server runs as a child of `claude`, not the Beecork daemon.
// It communicates with the daemon via shared SQLite + signal files.

// Path helpers from util/paths.ts so daemon + MCP child always agree on locations,
// including when BEECORK_HOME env is set for isolation/testing.
const DB_PATH = getDbPath();
const CRON_RELOAD_SIGNAL = getCronReloadSignalPath();
const WATCHER_RELOAD_SIGNAL = getWatcherReloadSignalPath();

// Cached singleton connection (lives for the MCP server's lifetime).
// Pragma setup lives in openDb() so daemon + MCP child + doctor can't drift.
let cachedDb: Database.Database | null = null;
function getDb(): Database.Database {
  if (cachedDb) return cachedDb;
  cachedDb = openDb(DB_PATH);
  return cachedDb;
}
process.on('exit', () => {
  cachedDb?.close();
});

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

const server = new Server({ name: 'beecork', version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

// Pre-build a Map for O(1) tool-definition lookup. A typical agent turn fires
// 10+ tool calls and each one previously walked the 30-entry array.
const TOOL_DEFINITION_BY_NAME = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLERS[name];
  if (!handler) return fail(`Unknown tool: ${name}`);

  // Validate against the declared inputSchema before dispatch. Without this,
  // handlers had ad-hoc checks for some fields and silently passed-through bad
  // inputs (NaN limits, unrecognized enum values) for others.
  const def = TOOL_DEFINITION_BY_NAME.get(name);
  const validationError = validateToolArgs(
    def?.inputSchema,
    args as Record<string, unknown> | undefined,
  );
  if (validationError) return fail(validationError);

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

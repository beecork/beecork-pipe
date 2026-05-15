// MCP tool definitions for the Beecork MCP server.
// One array, one place to maintain the public tool surface. Handler logic
// lives in `./handlers.ts`; the server file (`./server.ts`) glues them.

export const TOOL_DEFINITIONS = [
  {
    name: 'beecork_remember',
    description: 'Store a fact in Beecork\'s long-term memory. Use this for preferences, decisions, server addresses, outcomes, or anything the user might want recalled in future sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The fact or information to remember' },
        scope: { type: 'string', enum: ['global', 'project', 'tab', 'auto'], description: 'Where to store: global (about the user), project (about this folder), tab (about this conversation), or auto (Claude decides)' },
        category: { type: 'string', description: 'For global scope: people, preferences, routines, or general' },
      },
      required: ['content'],
    },
  },
  {
    name: 'beecork_task_create',
    description: 'Schedule a task that will run automatically. The task sends a message to a Beecork tab at the scheduled time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name for the task' },
        scheduleType: {
          type: 'string',
          enum: ['at', 'every', 'cron'],
          description: '"at" = one-time ISO datetime, "every" = interval like "30m"/"2h"/"1d", "cron" = cron expression like "0 9 * * 1"',
        },
        schedule: { type: 'string', description: 'The schedule value (ISO datetime, interval, or cron expression)' },
        message: { type: 'string', description: 'The prompt/message to send when the task fires' },
        tabName: { type: 'string', description: 'Which tab to send the message to (default: "default")' },
      },
      required: ['name', 'scheduleType', 'schedule', 'message'],
    },
  },
  {
    name: 'beecork_task_list',
    description: 'List all scheduled tasks.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'beecork_task_delete',
    description: 'Delete a scheduled task by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'The ID of the task to delete' } },
      required: ['id'],
    },
  },
  {
    name: 'beecork_cron_create',
    description: '[DEPRECATED — use beecork_task_create] Schedule a task that will run automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name for the job' },
        scheduleType: { type: 'string', enum: ['at', 'every', 'cron'] },
        schedule: { type: 'string' },
        message: { type: 'string' },
        tabName: { type: 'string' },
      },
      required: ['name', 'scheduleType', 'schedule', 'message'],
    },
  },
  {
    name: 'beecork_cron_list',
    description: '[DEPRECATED — use beecork_task_list] List all scheduled tasks.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'beecork_cron_delete',
    description: '[DEPRECATED — use beecork_task_delete] Delete a scheduled task by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'beecork_watch_create',
    description: 'Create a watcher that periodically runs a check command and triggers an action when a condition is met.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name for the watcher' },
        description: { type: 'string', description: 'What to watch (natural language)' },
        checkCommand: { type: 'string', description: 'Shell command to run for checking' },
        condition: { type: 'string', description: 'When to trigger: "contains X", "not contains X", "> N", "< N", "any", "error"' },
        action: { type: 'string', enum: ['notify', 'fix', 'delegate'], description: 'What to do when triggered (default: notify)' },
        actionDetails: { type: 'string', description: 'For fix: command to run. For delegate: tab name + message.' },
        schedule: { type: 'string', description: 'How often to check: cron expression or interval like "5m", "1h"' },
      },
      required: ['name', 'checkCommand', 'condition', 'schedule'],
    },
  },
  {
    name: 'beecork_watch_list',
    description: 'List all watchers.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'beecork_watch_delete',
    description: 'Delete a watcher by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'beecork_tab_create',
    description: 'Create a new Beecork tab (an isolated Claude session with its own working directory and history).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Tab name (alphanumeric + hyphens, max 32 chars). Cannot be "default".' },
        workingDir: { type: 'string', description: 'Absolute path or ~/path for the tab\'s working directory' },
        template: { type: 'string', description: 'Name of a tab template from config (sets workingDir + systemPrompt)' },
        systemPrompt: { type: 'string', description: 'Tab-specific system prompt for Claude' },
      },
      required: ['name'],
    },
  },
  {
    name: 'beecork_tab_list',
    description: 'List all Beecork tabs and their status.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'beecork_send_message',
    description: 'Send a message to another Beecork tab. The message will be processed asynchronously by that tab\'s Claude subprocess.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabName: { type: 'string', description: 'Which tab to send to' },
        message: { type: 'string', description: 'The message text' },
      },
      required: ['tabName', 'message'],
    },
  },
  {
    name: 'beecork_recall',
    description: 'Search Beecork\'s memory and knowledge files for facts matching a query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (matches content substrings)' },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'beecork_notify',
    description: 'Send a notification to the user via their configured channels (Telegram, Discord, etc.).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'The notification text' },
        urgent: { type: 'boolean', description: 'Prepend a 🚨 prefix' },
      },
      required: ['message'],
    },
  },
  {
    name: 'beecork_status',
    description: 'Get a summary of Beecork state: tab/task/watcher/memory counts.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'beecork_send_media',
    description: 'Send a generated or local media file (image/video/audio) through the user\'s channels.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the media file' },
        caption: { type: 'string', description: 'Optional caption' },
        tabName: { type: 'string', description: 'Tab to attribute the send to (default: "default")' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'beecork_channels',
    description: 'List configured channels and their capabilities.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'beecork_cost',
    description: 'Get cost summary (today, 7-day, 30-day, per-tab).',
    inputSchema: {
      type: 'object' as const,
      properties: { tabName: { type: 'string', description: 'Filter to a single tab' } },
    },
  },
  {
    name: 'beecork_failed_deliveries',
    description: 'List recent messages that failed to deliver via channels.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'beecork_activity',
    description: 'Get activity summary for the last N hours.',
    inputSchema: {
      type: 'object' as const,
      properties: { hours: { type: 'number', description: 'Lookback window (default 24)' } },
    },
  },
  {
    name: 'beecork_export_data',
    description: 'Export historical data as JSON for analysis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['costs', 'messages', 'crons'], description: 'What to export' },
        days: { type: 'number', description: 'Lookback window in days (default 30)' },
      },
      required: ['type'],
    },
  },
  {
    name: 'beecork_handoff',
    description: 'Get info to resume a tab\'s session in your terminal.',
    inputSchema: {
      type: 'object' as const,
      properties: { tabName: { type: 'string' } },
      required: ['tabName'],
    },
  },
  {
    name: 'beecork_delegate',
    description: 'Delegate a sub-task to another tab. The result will be sent back when complete.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabName: { type: 'string', description: 'Tab to delegate to' },
        message: { type: 'string', description: 'The task description' },
        returnToTab: { type: 'string', description: 'Tab to notify when complete (default: "default")' },
      },
      required: ['tabName', 'message'],
    },
  },
  {
    name: 'beecork_delegation_status',
    description: 'List pending delegations.',
    inputSchema: {
      type: 'object' as const,
      properties: { tabName: { type: 'string', description: 'Filter by source or target tab' } },
    },
  },
  {
    name: 'beecork_project_create',
    description: 'Register a project folder so the router can detect it from natural language.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Project name (also the folder name)' },
        path: { type: 'string', description: 'Optional parent directory (must be under a scan path)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'beecork_project_list',
    description: 'List registered projects/folders.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'beecork_close_tab',
    description: 'Permanently close a tab — stops its subprocess and deletes its message history.',
    inputSchema: {
      type: 'object' as const,
      properties: { tabName: { type: 'string' } },
      required: ['tabName'],
    },
  },
  {
    name: 'beecork_generate_image',
    description: 'Generate an image via a configured media provider (DALL-E, Recraft, etc.).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string' },
        style: { type: 'string' },
        provider: { type: 'string' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'beecork_generate_video',
    description: 'Generate a video via a configured media provider.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string' },
        duration: { type: 'number' },
        provider: { type: 'string' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'beecork_generate_audio',
    description: 'Generate audio via a configured media provider.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string' },
        provider: { type: 'string' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'beecork_media_providers',
    description: 'List configured media generators and what they support.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'beecork_knowledge',
    description: 'List all stored knowledge (memories + knowledge files), optionally filtered by scope.',
    inputSchema: {
      type: 'object' as const,
      properties: { scope: { type: 'string', enum: ['global', 'project', 'tab', 'all'] } },
    },
  },
  {
    name: 'beecork_capabilities',
    description: 'List available capability packs and their status.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'beecork_history',
    description: 'Get the activity timeline for a given day/tab.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'ISO date YYYY-MM-DD (default: today)' },
        tabName: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'beecork_replay',
    description: 'Re-run a past activity event by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
    },
  },
  {
    name: 'beecork_store_search',
    description: 'Search the Beecork community extension registry (npm packages starting with "beecork-").',
    inputSchema: {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

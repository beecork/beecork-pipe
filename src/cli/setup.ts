import readline from 'node:readline';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { saveConfig, getConfig } from '../config.js';
import { ensureBeecorkDirs, getMcpConfigPath, getBeecorkHome } from '../util/paths.js';
import { installService } from '../service/install.js';
import { getDb, closeDb } from '../db/index.js';
import type { BeecorkConfig } from '../types.js';

function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function findClaudeBin(): string {
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0];
  } catch {
    return 'claude';
  }
}

export async function setupWizard(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n🔧 Beecork Setup\n');
  console.log('This wizard will configure Beecork to make Claude Code always-on.\n');

  try {
    // 0. Auto-detect Claude Code
    let claudeCodeMissing = false;
    console.log('Checking prerequisites...\n');
    try {
      const version = execSync('claude --version 2>&1', { encoding: 'utf-8' }).trim();
      console.log(`  ✓ Claude Code found: ${version}`);
    } catch {
      claudeCodeMissing = true;
      console.log('  ✗ Claude Code is not installed yet.');
      console.log('');
      console.log('    Claude Code is the AI brain that Beecork connects to.');
      console.log('    You need a Claude Pro or Max subscription ($20/month) from anthropic.com');
      console.log('    Then install it: npm install -g @anthropic-ai/claude-code');
      console.log('');
      console.log('    You can continue setup now and install Claude Code afterwards.');
      console.log('    Beecork will remind you at the end.');
      console.log('');
      console.log(
        '    Guide: https://github.com/beecork/beecork-pipe/blob/main/docs/getting-started.md#prerequisites',
      );
    }
    console.log('');

    // 1. Telegram token with step-by-step instructions
    console.log('Step 1: Create a Telegram Bot');
    console.log('');
    console.log('  A Telegram bot is your personal AI phone number.');
    console.log('  Only you can talk to it — nobody else can access your Claude.');
    console.log('');
    console.log('  How to create one:');
    console.log('  1. Open Telegram on your phone');
    console.log('  2. Search for @BotFather (it has a blue checkmark)');
    console.log('  3. Tap "Start" and then send: /newbot');
    console.log('  4. Choose a display name (e.g., "My Beecork")');
    console.log('  5. Choose a username ending in "bot" (e.g., "mybeecork_bot")');
    console.log('  6. BotFather will reply with a token — copy it');
    console.log('');
    console.log(
      '  Detailed guide: https://github.com/beecork/beecork-pipe/blob/main/docs/getting-started.md\n',
    );

    let token = '';
    while (!token) {
      token = await ask(rl, 'Paste your Telegram Bot token');
      if (!token) {
        console.log('Telegram token is required. Get one from @BotFather on Telegram.');
        continue;
      }

      // Validate token by calling getMe
      try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { result: { username: string } };
          console.log(`  ✓ Connected to bot: @${data.result.username}\n`);
        } else {
          console.log('  ✗ Invalid token. Please check and try again.\n');
          token = '';
        }
      } catch {
        console.log('  \u26A0 Could not verify token (network error). Continuing anyway.\n');
      }
    }

    // 2. Telegram user ID
    console.log('Step 2: Find your Telegram User ID');
    console.log('');
    console.log('  Your user ID tells Beecork who is allowed to use the bot.');
    console.log('  Without it, anyone who finds your bot could use your Claude.');
    console.log('');
    console.log('  How to find it:');
    console.log('  1. Search for @userinfobot on Telegram');
    console.log('  2. Tap "Start" and send it any message');
    console.log('  3. It replies with your user ID (a number like 123456789)');
    console.log('');
    console.log(
      '  Detailed guide: https://github.com/beecork/beecork-pipe/blob/main/docs/getting-started.md\n',
    );

    const userIdStr = await ask(rl, 'Your Telegram user ID');
    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId)) {
      console.log('Invalid user ID. Must be a number.');
      return;
    }

    const claudeBin = findClaudeBin();
    const defaultDir = os.homedir();
    const scanPaths = ['~/Coding', '~/Projects', '~/code', '~/dev'];

    // Build config
    const config: BeecorkConfig = {
      ...getConfig(),
      telegram: {
        token,
        allowedUserIds: [userId],
      },
      claudeCode: {
        bin: claudeBin,
        defaultFlags: ['--dangerously-skip-permissions'],
        computerUse: false,
      },
      tabs: {
        default: {
          workingDir: defaultDir,
        },
      },
      memory: {
        dbPath: '~/.beecork-pipe/memory.db',
      },
      projectScanPaths: scanPaths,
      deployment: 'local',
    };

    // Write everything
    ensureBeecorkDirs();
    saveConfig(config);
    console.log(`\n✓ Config saved to ${getBeecorkHome()}/config.json`);

    // Initialize database
    getDb();
    closeDb();
    console.log('✓ Database initialized');

    // Generate MCP config
    generateMcpConfig();
    console.log(`✓ MCP config generated at ${getMcpConfigPath()}`);

    // Discover projects on disk
    {
      const { discoverProjects } = await import('../projects/index.js');
      const projects = discoverProjects(config.projectScanPaths);
      console.log(`✓ Discovered ${projects.length} projects`);
      closeDb();
    }

    // Install service
    {
      try {
        const servicePath = installService();
        console.log(`✓ Service installed at ${servicePath}`);
      } catch (err) {
        console.log(`⚠ Service install failed: ${err instanceof Error ? err.message : err}`);
        console.log('  You can start beecork-pipe manually with: beecork-pipe start');
      }
    }

    console.log('\n✅ Setup complete!\n');

    if (claudeCodeMissing) {
      console.log('  ⚠️  IMPORTANT: Install Claude Code before starting the daemon:');
      console.log('');
      console.log('     npm install -g @anthropic-ai/claude-code');
      console.log('');
      console.log('     You also need a Claude Pro or Max subscription ($20/month).');
      console.log('     Sign up at: https://claude.ai');
      console.log(
        '     Guide: https://github.com/beecork/beecork-pipe/blob/main/docs/getting-started.md#prerequisites',
      );
      console.log('');
    }

    console.log('  Next steps:');
    console.log('    1. Start the daemon:  beecork-pipe start');
    console.log('    2. Send a message to your Telegram bot');
    console.log('    3. Check status:      beecork-pipe status');
    console.log('');
    console.log('  Useful commands:');
    console.log('    beecork-pipe doctor     — check if everything is working');
    console.log('    beecork-pipe dashboard  — open web control panel');
    console.log('    beecork-pipe quickstart — full getting-started checklist');
    console.log('');

    console.log('  Add more channels:');
    console.log('    beecork-pipe whatsapp           — connect WhatsApp');
    console.log('    beecork-pipe discord            — connect Discord');
    console.log('    beecork-pipe webhook            — enable webhook API');
    console.log('');
    console.log('  Add more features:');
    console.log('    beecork-pipe media setup        — image, video, audio generation');
    console.log('    beecork-pipe enable github      — repos, PRs, issues');
    console.log('    beecork-pipe enable notion      — pages, databases, notes');
    console.log('    beecork-pipe computer-use enable — mouse, keyboard, screen control');
    console.log('');

    console.log(
      '  Need help? https://github.com/beecork/beecork-pipe/blob/main/docs/troubleshooting.md\n',
    );
  } finally {
    rl.close();
  }
}

function generateMcpConfig(): void {
  // Find the MCP server path
  const distDir = path.dirname(new URL(import.meta.url).pathname);
  // In dist: cli/setup.js -> ../mcp/server.js
  const mcpServerPath = path.resolve(distDir, '..', 'mcp', 'server.js');

  // For development (tsx), use the src path
  const srcMcpPath = path.resolve(distDir, '..', 'mcp', 'server.ts');

  let serverCommand: string;
  let serverArgs: string[];

  if (fs.existsSync(mcpServerPath)) {
    serverCommand = 'node';
    serverArgs = [mcpServerPath];
  } else if (fs.existsSync(srcMcpPath)) {
    // Development mode: use tsx
    serverCommand = 'npx';
    serverArgs = ['tsx', srcMcpPath];
  } else {
    // Fallback: assume global install
    serverCommand = 'node';
    serverArgs = [mcpServerPath];
  }

  const mcpConfig = {
    mcpServers: {
      'beecork-pipe': {
        command: serverCommand,
        args: serverArgs,
        env: {
          BEECORK_HOME: getBeecorkHome(),
        },
      },
    },
  };

  fs.writeFileSync(getMcpConfigPath(), JSON.stringify(mcpConfig, null, 2) + '\n', { mode: 0o600 });
}

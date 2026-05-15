import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../util/logger.js';
import type { Channel, ChannelContext } from './types.js';

const CHANNEL_PREFIX = 'beecork-channel-';

/**
 * Discover and load community channel packages from node_modules.
 * Convention: packages named `beecork-channel-<name>` must export a default
 * class implementing the Channel interface.
 */
export async function loadCommunityChannels(ctx: ChannelContext): Promise<Channel[]> {
  const channels: Channel[] = [];

  // Require explicit opt-in via config to prevent supply-chain attacks
  const allowlist = ctx.config.communityChannels;
  if (!allowlist || allowlist.length === 0) return channels;

  // Look in global and local node_modules
  const searchPaths = [
    path.join(process.cwd(), 'node_modules'),
    // Global npm modules path varies by OS — try common locations
  ];

  // Also check if beecork is installed globally
  try {
    const globalPath = path.dirname(require.resolve('beecork/package.json'));
    const globalNodeModules = path.join(globalPath, '..');
    if (fs.existsSync(globalNodeModules)) {
      searchPaths.push(globalNodeModules);
    }
  } catch {}

  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) continue;

    try {
      const dirs = fs.readdirSync(searchPath);
      for (const dir of dirs) {
        if (!dir.startsWith(CHANNEL_PREFIX)) continue;
        if (!allowlist.includes(dir)) continue;

        const pkgPath = path.join(searchPath, dir);

        try {
          // Read package.json to find the main entry
          const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgPath, 'package.json'), 'utf-8'));
          const main = pkgJson.main || 'index.js';
          const entryPath = path.join(pkgPath, main);

          if (!fs.existsSync(entryPath)) {
            logger.warn(`Community channel ${dir}: entry point not found at ${entryPath}`);
            continue;
          }

          // Dynamic import — community channels run with full daemon access:
          // they can read every config token (Telegram, Discord, WhatsApp,
          // notification provider keys) AND every environment variable the
          // daemon inherits (including SSH-agent sockets, GitHub tokens,
          // anything sourced from your shell profile). A compromised
          // community-channel package is effectively a root credential drop.
          // Pin versions in package.json, audit before opting in, and treat
          // every entry in `communityChannels` as a trust anchor.
          logger.warn(
            `Loading community channel "${dir}" — this package will have FULL access to your channel tokens (Telegram/Discord/WhatsApp) and every environment variable inherited by the daemon (including SSH keys). Only enable if you trust the package author and have audited the version.`,
          );
          const module = await import(entryPath);
          const ChannelClass = module.default || module[Object.keys(module)[0]];

          if (!ChannelClass || typeof ChannelClass !== 'function') {
            logger.warn(`Community channel ${dir}: no default export found`);
            continue;
          }

          const instance = new ChannelClass(ctx) as Channel;

          // Validate it implements Channel interface (duck typing)
          if (
            !instance.id ||
            !instance.name ||
            typeof instance.start !== 'function' ||
            typeof instance.stop !== 'function'
          ) {
            logger.warn(`Community channel ${dir}: does not implement Channel interface`);
            continue;
          }

          channels.push(instance);
          logger.info(`Community channel loaded: ${instance.name} (${instance.id}) from ${dir}`);
        } catch (err) {
          logger.warn(`Failed to load community channel ${dir}:`, err);
        }
      }
    } catch (err) {
      logger.warn(`Failed to scan ${searchPath}:`, err);
    }
  }

  return channels;
}

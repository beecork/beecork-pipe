export type { NotificationProvider } from './types.js';

import { logger } from '../util/logger.js';
import type { NotificationProvider } from './types.js';
import type { NotificationConfig } from '../types.js';
import { PushoverProvider } from './pushover.js';
import { NtfyProvider } from './ntfy.js';
import { WebhookNotificationProvider } from './webhook-provider.js';

export function createNotificationProvider(
  config: NotificationConfig,
): NotificationProvider | null {
  switch (config.type) {
    case 'pushover':
      return new PushoverProvider(config.userKey, config.appToken);
    case 'ntfy':
      return new NtfyProvider(config.topic, config.server);
    case 'webhook':
      return new WebhookNotificationProvider(config.url, config.headers);
    default: {
      // Exhaustiveness check — TS will error here if NotificationConfig gains
      // a new variant without a matching case above.
      const _exhaustive: never = config;
      logger.warn(`Unknown notification provider: ${JSON.stringify(_exhaustive)}`);
      return null;
    }
  }
}

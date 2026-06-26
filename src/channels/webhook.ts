import http from 'node:http';
import crypto from 'node:crypto';
import { logger } from '../util/logger.js';
import { validateTabNameOrDefault } from '../config.js';
import { inboundLimiter } from '../util/rate-limiter.js';
import { MESSAGE_LIMITS } from '../util/text.js';
import { processInboundMessage } from './pipeline.js';
import type { WebhookConfig } from '../types.js';
import type { Channel, ChannelContext, SendOptions } from './types.js';

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export class WebhookChannel implements Channel {
  readonly id = 'webhook';
  readonly name = 'Webhook';
  readonly maxMessageLength = MESSAGE_LIMITS.WEBHOOK_PROMPT;

  private server: http.Server | null = null;
  private ctx: ChannelContext;

  constructor(ctx: ChannelContext) {
    this.ctx = ctx;
  }

  async start(): Promise<void> {
    const config = this.getConfig();
    if (!config?.enabled) return;

    // Fail-secure: a webhook running with no auth turns localhost-injected
    // prompts (from any local process or any user on a shared host) into
    // arbitrary claude --dangerously-skip-permissions runs. Require either
    // an authToken or hmacSecret, OR an explicit allowUnauthLocalhost opt-in.
    if (!config.authToken && !config.hmacSecret && !config.allowUnauthLocalhost) {
      logger.error(
        'Webhook channel refusing to start: no authToken or hmacSecret configured. ' +
          'Set one in ~/.beecork-pipe/config.json under webhook.authToken/hmacSecret, or ' +
          'explicitly opt in with webhook.allowUnauthLocalhost=true (NOT recommended on shared hosts).',
      );
      return;
    }

    const port = config.port || 8374;

    this.server = http.createServer(async (req, res) => {
      // CORS headers for API clients
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      // Parse URL
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      const match = url.pathname.match(/^\/webhook\/(.+)$/);
      if (!match) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Use POST /webhook/:tabName' }));
        return;
      }

      const tabName = decodeURIComponent(match[1]);

      // Validate tab name (allow "default" — it's a reference, not a creation)
      const tabError = validateTabNameOrDefault(tabName);
      if (tabError) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: tabError }));
        return;
      }

      // Read body first (needed for both JSON parsing and HMAC verification)
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MESSAGE_LIMITS.HTTP_BODY) {
          res.writeHead(413);
          res.end(JSON.stringify({ error: 'Payload too large' }));
          req.destroy();
          return;
        }
      }

      // Auth check (after body read, so HMAC can verify body)
      if (!this.authenticate(req, config, body)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      // Rate-limit AFTER auth so unauthenticated callers don't burn the budget
      if (!inboundLimiter.check(this.id)) {
        res.writeHead(429);
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }

      let payload: { prompt?: string; message?: string; sync?: boolean };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const prompt = payload.prompt || payload.message || '';
      if (!prompt) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing "prompt" or "message" field' }));
        return;
      }

      const isSync = payload.sync ?? false;
      const remote = req.socket.remoteAddress ?? 'webhook';

      try {
        if (isSync) {
          // Sync mode: route through the shared pipeline so routing/enrichment apply.
          const result = await processInboundMessage({
            text: prompt,
            media: [],
            channelId: this.id,
            tabManager: this.ctx.tabManager,
            userId: remote,
            sendProgress: () => {
              /* webhook has no progress channel */
            },
            overrideTabName: tabName,
          });
          res.writeHead(result.isError ? 500 : 200);
          res.end(
            JSON.stringify({
              text: result.responseText,
              tab: result.tabName,
              error: result.isError ? result.responseText : undefined,
            }),
          );
        } else {
          // Async mode: fire-and-forget through the pipeline.
          // Surface failures to the user via broadcastNotify since the HTTP response
          // is already 202 and the caller has no other way to learn.
          processInboundMessage({
            text: prompt,
            media: [],
            channelId: this.id,
            tabManager: this.ctx.tabManager,
            userId: remote,
            sendProgress: () => {
              /* webhook has no progress channel */
            },
            overrideTabName: tabName,
          })
            .then((result) => {
              if (result.isError && this.ctx.notifyCallback) {
                this.ctx
                  .notifyCallback(`Webhook async failed for "${tabName}": ${result.responseText}`)
                  .catch(() => {});
              }
            })
            .catch((err) => {
              logger.error(`Webhook async processing failed for tab ${tabName}:`, err);
              if (this.ctx.notifyCallback) {
                this.ctx
                  .notifyCallback(
                    `Webhook async failed for "${tabName}": ${err instanceof Error ? err.message : String(err)}`,
                  )
                  .catch(() => {});
              }
            });
          res.writeHead(202);
          res.end(JSON.stringify({ accepted: true, tab: tabName }));
        }
      } catch (err) {
        logger.error('Webhook handler error:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    });

    this.server.listen(port, '127.0.0.1', () => {
      logger.info(`Webhook channel listening on http://127.0.0.1:${port}/webhook/:tabName`);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    logger.info('Webhook channel stopped');
  }

  async sendMessage(_peerId: string, _text: string, _options?: SendOptions): Promise<void> {
    // Webhooks are request-response — responses are sent in the HTTP handler
  }

  async sendNotification(_message: string, _urgent?: boolean): Promise<void> {
    // Webhook channel doesn't have persistent connections to send notifications to
  }

  async setTyping(_peerId: string, _active: boolean): Promise<void> {
    // No typing indicators for webhooks
  }

  private authenticate(req: http.IncomingMessage, config: WebhookConfig, body: string): boolean {
    // No auth configured = allow all (localhost only)
    if (!config.authToken && !config.hmacSecret) return true;

    // Bearer token auth (constant-time compare)
    if (config.authToken) {
      const authHeader = req.headers.authorization || '';
      if (safeEqualString(authHeader, `Bearer ${config.authToken}`)) return true;
    }

    // HMAC signature auth (for GitHub-style webhooks)
    if (config.hmacSecret) {
      const signature = req.headers['x-hub-signature-256'] as string;
      if (signature) {
        const expected =
          'sha256=' + crypto.createHmac('sha256', config.hmacSecret).update(body).digest('hex');
        try {
          return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
        } catch {
          return false; // Length mismatch or encoding error
        }
      }
    }

    return false;
  }

  private getConfig(): WebhookConfig | undefined {
    return this.ctx.config.webhook;
  }
}

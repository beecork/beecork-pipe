import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { getDashboardHtml } from './html.js';
import { logger } from '../util/logger.js';
import { safeEqual } from '../util/safe-equal.js';
import { dispatch, json } from './routes.js';

function openBrowser(url: string): void {
  const p = platform();
  if (p === 'darwin') execFile('open', [url]);
  else if (p === 'win32') execFile('cmd', ['/c', 'start', url]);
  else execFile('xdg-open', [url]);
}

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Extract the dashboard auth token from the Cookie header, if present. */
function readDashCookie(cookieHeader: string | undefined): string | undefined {
  return cookieHeader
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('beecork_dash='))
    ?.split('=')[1];
}

export function startDashboardServer(port = 0): void {
  // Generate auth token at server start (24 random bytes → 192-bit base64url).
  const authToken = crypto.randomBytes(24).toString('base64url');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost`);
    const path = url.pathname;

    // Serve HTML
    if (path === '/' || path === '/index.html') {
      // Accept the token from the query (first visit, from the terminal URL) OR
      // the cookie (returning visit). Never hand the token out via a redirect to
      // an unauthenticated request — that would let any local process scrape it
      // off `GET /` and drive the RCE-capable /api/* surface.
      const queryToken = url.searchParams.get('token');
      const cookieToken = readDashCookie(req.headers.cookie);
      const provided = queryToken || cookieToken;
      if (!safeEqual(provided, authToken)) {
        res.writeHead(401, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
        res.end(
          'Unauthorized. Open the dashboard using the URL (with ?token=...) printed in the daemon terminal.',
        );
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        ...SECURITY_HEADERS,
        'Set-Cookie': `beecork_dash=${authToken}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end(getDashboardHtml(authToken));
      return;
    }

    // Auth check for API routes (constant-time compare)
    if (path.startsWith('/api/')) {
      const authHeader = req.headers.authorization;
      const queryToken = url.searchParams.get('token');
      const cookieToken = readDashCookie(req.headers.cookie);
      const providedToken = authHeader?.replace('Bearer ', '') || queryToken || cookieToken;
      if (!safeEqual(providedToken, authToken)) {
        json(res, { error: 'Unauthorized' }, 401);
        return;
      }
    }

    try {
      const route = dispatch(req.method || 'GET', path);
      if (!route) {
        json(res, { error: 'Not found' }, 404);
        return;
      }
      await route.handler({ req, res, url, path });
    } catch (err) {
      logger.error('Dashboard error:', err);
      json(res, { error: 'Internal server error' }, 500);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      const url = `http://localhost:${addr.port}?token=${authToken}`;
      console.log(`\nBeecork Dashboard: ${url}\n`);
      console.log('Press Ctrl+C to stop.\n');
      openBrowser(url);
    }
  });

  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });
}

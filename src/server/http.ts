import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import type { Config, Seat } from '../config.ts';
import type { Store } from '../store/db.ts';
import { buildSnapshot } from './snapshot.ts';

export interface HostApi {
  start(goals: string[]): Promise<{ ok: boolean; error?: string }>;
  approve(): Promise<{ ok: boolean; error?: string }>;
  stop(): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  command(
    to: Seat,
    text: string
  ): { ok: boolean; id?: number; error?: string } | Promise<{ ok: boolean; id?: number; error?: string }>;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage, maxBytes = 16384): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = req.headers['content-length'];
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      req.resume();
      const err: any = new Error('Payload too large');
      err.statusCode = 413;
      reject(err);
      return;
    }

    let size = 0;
    const chunks: Buffer[] = [];
    let tooLarge = false;

    req.on('data', (chunk: Buffer | string) => {
      if (tooLarge) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        tooLarge = true;
        req.resume();
        const err: any = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.trim().length === 0) {
        const emptyErr: any = new Error('Request body cannot be empty');
        emptyErr.statusCode = 400;
        reject(emptyErr);
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch {
        const parseErr: any = new Error('Invalid JSON');
        parseErr.statusCode = 400;
        reject(parseErr);
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

export function createServer(o: {
  cfg: Config;
  store: Store;
  host: HostApi;
  webFile: string;
  pollMs?: number;
  pingMs?: number;
}): http.Server {
  interface SseClient {
    res: ServerResponse;
    cleanup: () => void;
  }

  const activeSockets = new Set<Socket>();
  const activeSseClients = new Set<SseClient>();

  const server = http.createServer(async (req, res) => {
    try {
      const hostHeader = req.headers.host || '127.0.0.1';
      const url = new URL(req.url ?? '/', `http://${hostHeader}`);
      const pathname = url.pathname;
      const method = req.method?.toUpperCase();

      // Static index route
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        if (!existsSync(o.webFile)) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
        const html = readFileSync(o.webFile, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
        });
        res.end(html);
        return;
      }

      // State snapshot route
      if (method === 'GET' && pathname === '/api/state') {
        const snapshot = buildSnapshot(o.store, o.cfg);
        sendJson(res, 200, snapshot);
        return;
      }

      // SSE event stream route
      if (method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
        });

        // Immediate snapshot push
        let lastJson = JSON.stringify(buildSnapshot(o.store, o.cfg));
        res.write(`event: state\ndata: ${lastJson}\n\n`);

        const pollIntervalMs = o.pollMs ?? 1000;
        const pollTimer = setInterval(() => {
          try {
            const currentJson = JSON.stringify(buildSnapshot(o.store, o.cfg));
            if (currentJson !== lastJson) {
              lastJson = currentJson;
              res.write(`event: state\ndata: ${currentJson}\n\n`);
            }
          } catch {
            // Ignore temporary snapshot build errors during poll
          }
        }, pollIntervalMs);

        const pingIntervalMs = o.pingMs ?? 15000;
        const pingTimer = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            // Ignore ping errors
          }
        }, pingIntervalMs);

        let closed = false;
        let sseClient: SseClient | null = null;
        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(pollTimer);
          clearInterval(pingTimer);
          if (sseClient) {
            activeSseClients.delete(sseClient);
          }
        };

        sseClient = { res, cleanup };
        activeSseClients.add(sseClient);

        req.on('close', cleanup);
        res.on('close', cleanup);
        return;
      }

      // POST routes require guard checks
      if (method === 'POST') {
        // 1. Guard x-btm
        const xBtm = req.headers['x-btm'];
        if (xBtm !== '1') {
          sendJson(res, 403, { error: 'Forbidden: missing or invalid x-btm header' });
          return;
        }

        // 2. Guard Origin (if present)
        if (req.headers['origin'] !== undefined) {
          const originHeader = req.headers['origin'];
          const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
          const localPort = req.socket.localPort;
          const cfgPort = o.cfg.host.dashboard.port;
          const allowed = new Set<string>();
          if (localPort) {
            allowed.add(`http://localhost:${localPort}`);
            allowed.add(`http://127.0.0.1:${localPort}`);
          }
          if (cfgPort) {
            allowed.add(`http://localhost:${cfgPort}`);
            allowed.add(`http://127.0.0.1:${cfgPort}`);
          }
          if (!origin || typeof origin !== 'string' || !allowed.has(origin)) {
            sendJson(res, 403, { error: 'Forbidden: invalid origin' });
            return;
          }
        }

        // 3. Guard Content-Type
        const ctHeader = req.headers['content-type'];
        const ct = Array.isArray(ctHeader) ? ctHeader[0] : ctHeader;
        const mime = ct ? ct.split(';')[0].trim().toLowerCase() : '';
        if (mime !== 'application/json') {
          sendJson(res, 415, { error: 'Content-Type must be application/json' });
          return;
        }

        // 4. Read body (max 16 KB)
        let body: unknown;
        try {
          body = await readJsonBody(req, 16384);
        } catch (err: any) {
          const status = err.statusCode || 400;
          sendJson(res, status, { error: err.message || 'Invalid request body' });
          return;
        }

        // Dispatch endpoints
        if (pathname === '/api/session') {
          const SessionSchema = z.object({
            goals: z
              .array(z.string().trim().min(1))
              .min(1)
              .max(o.cfg.session.max_goals),
          });
          const parsed = SessionSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
            return;
          }
          const result = await o.host.start(parsed.data.goals);
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/approve') {
          const ApproveSchema = z.object({}).passthrough();
          const parsed = ApproveSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: 'Invalid body' });
            return;
          }
          const result = await o.host.approve();
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/stop') {
          const StopSchema = z.object({}).passthrough();
          const parsed = StopSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: 'Invalid body' });
            return;
          }
          const result = await o.host.stop();
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/command') {
          const CommandSchema = z.object({
            to: z.enum(['pm', 'dev', 'qc']),
            text: z.string().trim().min(1).max(2000),
          });
          const parsed = CommandSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
            return;
          }
          const result = await o.host.command(parsed.data.to, parsed.data.text);
          sendJson(res, 200, result);
          return;
        }

        // Other POST paths
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      // Any other method/route
      sendJson(res, 404, { error: 'Not found' });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message || 'Internal server error' });
    }
  });

  server.on('connection', (sock) => {
    activeSockets.add(sock);
    sock.on('close', () => activeSockets.delete(sock));
  });

  const originalClose = server.close.bind(server);
  server.close = function (cb?: (err?: Error) => void): http.Server {
    for (const client of Array.from(activeSseClients)) {
      client.cleanup();
      try {
        client.res.end();
      } catch {}
    }
    activeSseClients.clear();

    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    } else {
      for (const sock of activeSockets) {
        try {
          sock.destroy();
        } catch {}
      }
    }

    return originalClose(cb);
  };

  server.on('close', () => {
    for (const client of Array.from(activeSseClients)) {
      client.cleanup();
      try {
        client.res.end();
      } catch {}
    }
    activeSseClients.clear();
    for (const sock of activeSockets) {
      try {
        sock.destroy();
      } catch {}
    }
    activeSockets.clear();
  });

  return server;
}

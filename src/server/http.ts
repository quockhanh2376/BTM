import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Config, Seat } from '../config.ts';
import type { Store } from '../store/db.ts';
import { buildSnapshot } from './snapshot.ts';
import { commitAll } from '../git.ts';
import { inboxPath, detectImage } from './inbox.ts';

export interface HostApi {
  start(
    goals: string[],
    opts?: {
      noteId?: number;
      prepare?: () => Promise<{ noteId?: number } | void> | { noteId?: number } | void;
    }
  ): Promise<{ ok: boolean; error?: string }>;
  approve(): Promise<{ ok: boolean; error?: string }>;
  stop(): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  command(
    to: Seat | 'team',
    text: string
  ): { ok: boolean; id?: number; error?: string } | Promise<{ ok: boolean; id?: number; error?: string }>;
  setAutoApprove?(enabled: boolean): void | Promise<void>;
  busy?(): boolean;
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

      // Note image route
      const noteImageMatch = pathname.match(/^\/api\/notes\/([^/]+)\/image$/);
      if (method === 'GET' && noteImageMatch) {
        const rawId = noteImageMatch[1];
        const noteId = Number(rawId.replace(/^N-/, ''));
        if (isNaN(noteId)) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
        const activeProject = o.store.getActiveProject();
        if (!activeProject) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
        const note = o.store.getNote(noteId);
        if (!note || note.project !== activeProject || !note.image) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }

        const validNameRegex = new RegExp(`^(N-)?${noteId}\\.(png|jpg|webp)$`);
        if (!validNameRegex.test(note.image)) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }

        let imgPath: string;
        try {
          imgPath = inboxPath(activeProject, note.image);
          const stat = lstatSync(imgPath);
          if (!stat.isFile()) {
            sendJson(res, 404, { error: 'Not found' });
            return;
          }
        } catch {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }

        let imgBuf: Buffer;
        try {
          imgBuf = readFileSync(imgPath);
        } catch {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }

        const detected = detectImage(imgBuf);
        if (!detected) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }

        if (!note.image.endsWith(`.${detected.ext}`)) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }

        res.writeHead(200, {
          'Content-Type': detected.mime,
          'Content-Length': imgBuf.length,
        });
        res.end(imgBuf);
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

        // 4. Read body (max 16 KB, or 7 MB for team-note)
        const maxBytes = pathname === '/api/team-note' ? 7 * 1024 * 1024 : 16384;
        let body: unknown;
        try {
          body = await readJsonBody(req, maxBytes);
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
          const allowedSeats = [...Object.keys(o.cfg.seats), 'team'];
          const CommandSchema = z.object({
            to: z.string().refine((val) => allowedSeats.includes(val), { message: 'Invalid recipient' }),
            text: z.string().trim().min(1).max(2000),
          });
          const parsed = CommandSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
            return;
          }
          const result = await o.host.command(parsed.data.to as Seat | 'team', parsed.data.text);
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/team-note') {
          const TeamNoteSchema = z.object({
            text: z.string().trim().min(1).max(2000),
            image: z
              .object({
                name: z.string().min(1),
                base64: z.string().min(1),
              })
              .optional(),
          });
          const parsed = TeamNoteSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
            return;
          }

          const activeProject = o.store.getActiveProject();
          if (!activeProject) {
            sendJson(res, 400, { error: 'Chưa có dự án active' });
            return;
          }

          let imgBuf: Buffer | null = null;
          let ext: string | null = null;

          if (parsed.data.image) {
            try {
              imgBuf = Buffer.from(parsed.data.image.base64, 'base64');
            } catch {
              sendJson(res, 400, { error: 'Invalid base64 image data' });
              return;
            }

            if (imgBuf.length > 5 * 1024 * 1024) {
              sendJson(res, 413, { error: 'Image exceeds 5 MB limit' });
              return;
            }

            const detected = detectImage(imgBuf);
            if (!detected) {
              sendJson(res, 415, { error: 'Unsupported image format' });
              return;
            }
            ext = detected.ext;
          }

          if (o.host.busy && o.host.busy()) {
            sendJson(res, 409, { error: 'Đang có phiên chạy' });
            return;
          }

          try {
            inboxPath(activeProject, 'N-0');
          } catch (err: any) {
            sendJson(res, 400, { error: err?.message || 'team/inbox must be inside project' });
            return;
          }

          let createdNoteId: number = 0;
          let prepared = false;
          let commitFailed = false;
          let createdMdPath: string | null = null;
          let createdImgPath: string | null = null;

          const prepare = () => {
            prepared = true;
            createdNoteId = o.store.createNote(activeProject, parsed.data.text, null);
            try {
              const imageName = ext ? `N-${createdNoteId}.${ext}` : null;
              if (imageName) {
                o.store.setNoteImage(createdNoteId, imageName);
              }

              if (imgBuf && imageName) {
                const imgPath = inboxPath(activeProject, imageName);
                try {
                  lstatSync(imgPath);
                  throw new Error(`Target image file already exists: ${imageName}`);
                } catch (err: any) {
                  if (err?.code !== 'ENOENT') throw err;
                }
                writeFileSync(imgPath, imgBuf, { flag: 'wx' });
                createdImgPath = imgPath;
              }

              const now = new Date().toISOString();
              const noteMdLines = [
                '---',
                `id: N-${createdNoteId}`,
                'from: owner',
                'status: open',
                `at: ${now}`,
              ];
              if (imageName) {
                noteMdLines.push(`image: ${imageName}`);
              }
              noteMdLines.push('---', parsed.data.text, '');

              const mdPath = inboxPath(activeProject, `N-${createdNoteId}.md`);
              try {
                lstatSync(mdPath);
                throw new Error(`Target note file already exists: N-${createdNoteId}.md`);
              } catch (err: any) {
                if (err?.code !== 'ENOENT') throw err;
              }
              writeFileSync(mdPath, noteMdLines.join('\n'), { flag: 'wx', encoding: 'utf8' });
              createdMdPath = mdPath;

              try {
                commitAll(activeProject, `inbox N-${createdNoteId}`, { name: 'owner', email: 'owner@btm.local' });
              } catch (err: any) {
                commitFailed = true;
                throw new Error(`Commit note failed: ${err?.message || String(err)}`);
              }
            } catch (err: any) {
              if (createdMdPath) {
                try { rmSync(createdMdPath, { force: true }); } catch {}
              }
              if (createdImgPath) {
                try { rmSync(createdImgPath, { force: true }); } catch {}
              }
              if (createdNoteId) {
                try { o.store.deleteNote(createdNoteId); } catch {}
              }
              throw err;
            }

            return { noteId: createdNoteId };
          };

          const initialGoal = `Xử lý ghi chú team N-?: ${parsed.data.text.slice(0, 200)}`;
          let result: { ok: boolean; error?: string };
          try {
            result = await o.host.start([initialGoal], { prepare });
          } catch (err: any) {
            if (commitFailed) {
              sendJson(res, 500, { error: err?.message || 'Commit note failed' });
              return;
            }
            sendJson(res, 400, { error: err?.message || 'Error starting session' });
            return;
          }

          if (!prepared && result.ok) {
            try {
              prepare();
            } catch (err: any) {
              if (commitFailed) {
                sendJson(res, 500, { error: err?.message || 'Commit note failed' });
                return;
              }
              sendJson(res, 400, { error: err?.message || 'Error preparing note' });
              return;
            }
          }

          if (!result.ok) {
            if (commitFailed) {
              sendJson(res, 500, { error: result.error || 'Commit note failed' });
              return;
            }
            if (result.error === 'Đang có phiên chạy') {
              sendJson(res, 409, { error: 'Đang có phiên chạy' });
              return;
            }
            sendJson(res, 400, { error: result.error || 'Failed to start session' });
            return;
          }

          sendJson(res, 200, { id: createdNoteId, note: `N-${createdNoteId}`, ...result });
          return;
        }

        if (pathname === '/api/settings') {
          const SettingsSchema = z.object({
            autoApprove: z.boolean(),
          });
          const parsed = SettingsSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
            return;
          }
          if (o.host.setAutoApprove) {
            await o.host.setAutoApprove(parsed.data.autoApprove);
          }
          sendJson(res, 200, { ok: true, autoApprove: parsed.data.autoApprove });
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

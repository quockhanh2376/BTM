import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Config, Seat } from '../config.ts';
import { effectiveSeats, type Store } from '../store/db.ts';
import { buildSnapshot } from './snapshot.ts';
import { commitAll } from '../git.ts';
import { inboxPath, detectImage, readInboxFile } from './inbox.ts';
import type { createMonitor } from '../energy/monitor.ts';
import { approveGoal, type ApproveGoalResult } from '../ticket/goal.ts';

export interface HostApi {
  start(
    goals: string[],
    opts?: {
      noteId?: number;
      text?: string;
      image?: { ext: string; bytes: Buffer };
      note?: { noteId: number; text: string; image?: { ext: string; bytes: Buffer } };
      prepare?: () => Promise<{ noteId?: number } | void> | { noteId?: number } | void;
    }
  ): Promise<{ ok: boolean; error?: string }>;
  approve(): Promise<{ ok: boolean; error?: string }>;
  resume?(): Promise<{ ok: boolean; status?: number; error?: string }>;
  stop(): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  command(
    to: Seat | 'team',
    text: string
  ): { ok: boolean; id?: number; error?: string } | Promise<{ ok: boolean; id?: number; error?: string }>;
  setAutoApprove?(enabled: boolean): void | Promise<void>;
  busy?(): boolean;
  setSeat?(
    seat: Seat,
    agent: string
  ): { ok: boolean; status?: number; error?: string };
  approveGoal?(n: number): ApproveGoalResult | Promise<ApproveGoalResult>;
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
  monitor?: ReturnType<typeof createMonitor>;
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

        const imgBuf = readInboxFile(activeProject, note.image);
        if (!imgBuf) {
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

      // Ticket history route
      const ticketHistoryMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/history$/);
      if (method === 'GET' && ticketHistoryMatch) {
        const ticketId = ticketHistoryMatch[1];
        const activeProject = o.store.getActiveProject();
        if (!activeProject) {
          sendJson(res, 404, { error: 'No active project' });
          return;
        }
        const history = o.store.ticketHistory(activeProject, ticketId);
        sendJson(res, 200, history);
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

        if (pathname === '/api/goal/approve') {
          const GoalApproveSchema = z.object({
            goal: z.string().regex(/^G?(\d+)$/i, { message: 'Invalid goal format, expected G<n>' }),
          });
          const parsed = GoalApproveSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
            return;
          }
          if (o.host.busy?.()) {
            sendJson(res, 409, { ok: false, code: 'busy', error: 'Phiên/lượt đang chạy', message: 'Phiên/lượt đang chạy' });
            return;
          }
          const match = parsed.data.goal.match(/^G?(\d+)$/i);
          const goalNumber = parseInt(match![1], 10);
          let resGoal: ApproveGoalResult;
          if (o.host.approveGoal) {
            resGoal = await o.host.approveGoal(goalNumber);
          } else {
            const activeProject = o.store.getActiveProject();
            if (!activeProject) {
              sendJson(res, 409, { ok: false, code: 'not_ready', error: 'Chưa có dự án active', message: 'Chưa có dự án active' });
              return;
            }
            resGoal = approveGoal(o.store, activeProject, o.cfg, goalNumber);
          }
          if (resGoal.ok) {
            sendJson(res, 200, resGoal);
          } else {
            sendJson(res, 409, { ok: false, code: resGoal.code, message: resGoal.message, error: resGoal.message });
          }
          return;
        }

        if (pathname === '/api/resume') {
          const ResumeSchema = z.object({}).passthrough();
          const parsed = ResumeSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: 'Invalid body' });
            return;
          }
          if (o.host.busy?.()) {
            sendJson(res, 409, { error: 'Phiên/lượt đang chạy' });
            return;
          }
          if (o.host.resume) {
            const result = await o.host.resume();
            sendJson(res, result.ok ? 200 : (result.status || 400), result);
          } else {
            sendJson(res, 501, { error: 'Not implemented' });
          }
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
          const allowedSeats = [...Object.keys(effectiveSeats(o.cfg, o.store)), 'team'];
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

          if (o.host.busy && o.host.busy()) {
            sendJson(res, 409, { error: 'Đang có phiên chạy' });
            return;
          }

          let imgBuf: Buffer | null = null;
          let ext: 'png' | 'jpg' | 'webp' | null = null;

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

          try {
            inboxPath(activeProject, 'N-0');
          } catch (err: any) {
            sendJson(res, 400, { error: err?.message || 'team/inbox must be inside project' });
            return;
          }

          const createdNoteId = o.store.createNote(activeProject, parsed.data.text, null);
          const imageName = ext ? `N-${createdNoteId}.${ext}` : null;
          if (imageName) {
            o.store.setNoteImage(createdNoteId, imageName);
          }

          const imageOpt = (ext && imgBuf) ? { ext, bytes: imgBuf } : undefined;
          const initialGoal = `Xử lý ghi chú team N-${createdNoteId}: ${parsed.data.text.slice(0, 200)}`;
          let result: { ok: boolean; error?: string };
          try {
            result = await o.host.start([initialGoal], {
              noteId: createdNoteId,
              text: parsed.data.text,
              image: imageOpt,
              note: {
                noteId: createdNoteId,
                text: parsed.data.text,
                image: imageOpt,
              },
            });
          } catch (err: any) {
            try {
              o.store.deleteNote(createdNoteId);
            } catch {}
            sendJson(res, 400, { error: err?.message || 'Error starting session' });
            return;
          }

          if (!result.ok) {
            try {
              o.store.deleteNote(createdNoteId);
            } catch {}
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

        if (pathname === '/api/energy/refresh') {
          const RefreshSchema = z.object({}).passthrough();
          const parsed = RefreshSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: 'Invalid body' });
            return;
          }
          const monitor = o.monitor ?? (o.host as any)?.monitor;
          if (monitor) {
            await monitor.refresh(Object.keys(o.cfg.agents), true);
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (pathname === '/api/seat') {
          const SeatBodySchema = z.object({
            seat: z.string(),
            agent: z.string(),
          });
          const parsed = SeatBodySchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
            return;
          }
          if (o.host.busy?.()) {
            sendJson(res, 409, { error: 'Phiên/lượt đang chạy' });
            return;
          }
          const { seat, agent } = parsed.data;
          if (!Object.hasOwn(o.cfg.seats, seat)) {
            sendJson(res, 400, { error: `Ghế "${seat}" không hợp lệ` });
            return;
          }
          if (!Object.hasOwn(o.cfg.agents, agent)) {
            sendJson(res, 400, { error: `Agent "${agent}" không thể ngồi ghế "${seat}"` });
            return;
          }
          const agentCfg = o.cfg.agents[agent];
          if (!agentCfg || !agentCfg.can_sit.includes(seat as Seat)) {
            sendJson(res, 400, { error: `Agent "${agent}" không thể ngồi ghế "${seat}"` });
            return;
          }
          if (o.host.setSeat) {
            const result = await o.host.setSeat(seat as Seat, agent);
            if (!result.ok) {
              sendJson(res, result.status || 400, { error: result.error });
              return;
            }
          } else {
            const current = effectiveSeats(o.cfg, o.store)[seat as Seat];
            o.store.setSetting(`seat:${seat}`, agent);
            console.log(`Đổi ghế ${seat}: ${current} → ${agent}`);
          }
          sendJson(res, 200, { ok: true, seat, agent });
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

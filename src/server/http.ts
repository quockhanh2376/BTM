import type { createSkillsLane } from '../skills/lane.ts';
import { searchBtm } from './search.ts';
import { createSystemReader } from './system.ts';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { readFileSync, existsSync, mkdirSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute, dirname } from 'node:path';
import type { Config, Seat } from '../config.ts';
import type { Store } from '../store/db.ts';
import { buildSnapshot } from './snapshot.ts';
import { commitAll } from '../git.ts';
import { handleAccountsGet, handleAccountsPost, IMPORT_MAX_BYTES } from './accounts-api.ts';
import { handleGoalsGet, handleGoalsPost } from './routes/goals.ts';
import { handleTicketsGet, handleTicketsPost } from './routes/tickets.ts';
import { handleQuestionsPost } from './routes/questions.ts';
import { handleNotesGet, handleNotesPost } from './routes/notes.ts';
import { handleSeatsGet, handleSeatsPost } from './routes/seats.ts';
import { handleSessionPost } from './routes/session.ts';
import { handleMeetingGet, handleMeetingPost } from './routes/meeting.ts';
import { handleSkillsGet, handleSkillsPost } from './routes/skills.ts';
import { handleSettingsGet, handleSettingsPost } from './routes/settings.ts';
import type { AdminExec } from '../isolation/account-admin.ts';
import type { SpawnFn } from '../agents/login-flow.ts';
import type { createMonitor } from '../energy/monitor.ts';
import type { ApproveGoalResult } from '../ticket/goal.ts';
import type { ReleaseInfo } from '../release/publish.ts';
import { readFolders, type ExecAsync } from './folders.ts';

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
  delegateAnswers?(): Promise<{ ok: boolean; status?: number; error?: string }>;
  stop(seat?: Seat): { ok: boolean; status?: number; error?: string } | Promise<{ ok: boolean; status?: number; error?: string }>;
  command(
    to: Seat | 'team' | `ask-${Seat}`,
    text: string
  ): { ok: boolean; id?: number; error?: string } | Promise<{ ok: boolean; id?: number; error?: string }>;
  setAutoApprove?(enabled: boolean): void | Promise<void>;
  busy?(): boolean;
  setSeat?(
    seat: Seat,
    agent: string
  ): { ok: boolean; status?: number; error?: string };
  approveGoal?(n: number): ApproveGoalResult | Promise<ApproveGoalResult>;
  retryRelease?(n: number): Promise<ReleaseInfo | null>;
  /** Họp tranh luận (2026-11-14). */
  meeting?(
    action: 'start' | 'stop' | 'resume' | 'conclude' | 'close' | 'decide',
    p: { topic?: string; quick?: boolean; note?: string; options?: string[]; option?: string }
  ): Promise<{ ok: true; id: number } | { ok: false; status: number; error: string }>;
  /** Dọn Meeting room (2026-11-14): xoá hẳn cuộc họp đã kết thúc trước mốc. */
  purgeMeetingsBefore?(before: string): number;
  /** Skill cho agent (2026-11-14): thư viện + cổng bảo mật. */
  skills?: ReturnType<typeof createSkillsLane>;
  /** Tài liệu đính kèm cuộc họp sắp mở (bước 2). */
  meetingDocs?: {
    add(name: string, bytes: Buffer): Promise<{ ok: true; doc: { id: number; name: string; note: string; chars: number } } | { ok: false; status: number; error: string }>;
    remove(id: number): Array<{ id: number; name: string; note: string; chars: number }>;
    list(): Array<{ id: number; name: string; note: string; chars: number }>;
  };
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
  /** Plan 7: test truyền exec/spawn giả cho tạo user, token, đăng nhập. */
  accountExec?: AdminExec;
  loginSpawn?: SpawnFn;
  /** Tab Folder: test truyền exec giả cho lệnh đọc workspace dưới user worker. */
  foldersExec?: ExecAsync;
}): http.Server {
  const readSystem = createSystemReader(o.cfg.host.data_dir);
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
          // Deploy xong anh mở lại là có bản mới, không dùng trang cũ trong cache.
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            // blob:/data: ảnh: thu nhỏ avatar và xem trước ảnh đính kèm cần tải ảnh cục bộ.
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' blob: data:",
        });
        res.end(html);
        return;
      }

      // File tĩnh của dashboard (tách từ index.html, 2026-11-14): chỉ tên an toàn trong web/app/, không cache.
      const assetMatch = method === 'GET' ? pathname.match(/^\/app\/([a-z0-9-]{1,40})\.(js|css)$/) : null;
      if (assetMatch) {
        const file = join(dirname(o.webFile), 'app', `${assetMatch[1]}.${assetMatch[2]}`);
        if (!existsSync(file)) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': assetMatch[2] === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(readFileSync(file, 'utf-8'));
        return;
      }

      const accountsCtx = { cfg: o.cfg, store: o.store, busy: () => Boolean(o.host.busy?.()), exec: o.accountExec, spawn: o.loginSpawn };
      if (method === 'GET' && handleAccountsGet(pathname, accountsCtx, res, sendJson)) return;

      // Plan 9 Task 2: CPU/RAM/Disk/Net cho khung System Status (chỉ đọc).
      if (method === 'GET' && pathname === '/api/system') {
        sendJson(res, 200, readSystem());
        return;
      }

      // Tab Folder: chỉ xem cấu trúc repo chính + workspace từng account (tên file, không nội dung).
      if (method === 'GET' && pathname === '/api/folders') {
        sendJson(res, 200, await readFolders(o.cfg, o.store, o.foldersExec));
        return;
      }

      if (await handleGoalsGet(method, pathname, undefined, o, res, sendJson)) return;
      if (await handleSkillsGet(method, pathname, undefined, o, res, sendJson)) return;
      if (await handleSettingsGet(method, pathname, undefined, o, res, sendJson)) return;
      if (await handleMeetingGet(method, pathname, undefined, o, res, sendJson)) return;

      // Ô Search (chỉ đọc, không lưu): ?q=… → { hits }.
      if (method === 'GET' && pathname === '/api/search') {
        sendJson(res, 200, { hits: searchBtm(o.store, o.cfg, url.searchParams.get('q') ?? '') });
        return;
      }

      // State snapshot route
      if (method === 'GET' && pathname === '/api/state') {
        const snapshot = buildSnapshot(o.store, o.cfg);
        sendJson(res, 200, snapshot);
        return;
      }

      if (await handleSeatsGet(method, pathname, undefined, o, res, sendJson)) return;
      if (await handleNotesGet(method, pathname, undefined, o, res, sendJson)) return;

      if (await handleTicketsGet(method, pathname, undefined, o, res, sendJson)) return;

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
        const maxBytes = pathname === '/api/team-note' || /^\/api\/questions\/\d{1,9}\/answer$/.test(pathname) ? 7 * 1024 * 1024 : pathname === '/api/accounts/import' ? IMPORT_MAX_BYTES : pathname === '/api/meeting/doc' ? 28 * 1024 * 1024 : pathname === '/api/skills' ? 256 * 1024 : pathname === '/api/agent' ? 96 * 1024 : 16384;
        let body: unknown;
        try {
          body = await readJsonBody(req, maxBytes);
        } catch (err: any) {
          const status = err.statusCode || 400;
          sendJson(res, status, { error: err.message || 'Invalid request body' });
          return;
        }

        // Dispatch endpoints
        if (await handleSessionPost(method, pathname, body, o, res, sendJson)) return;

        if (await handleGoalsPost(method, pathname, body, o, res, sendJson)) return;
        if (await handleSettingsPost(method, pathname, body, o, res, sendJson)) return;

        if (await handleQuestionsPost(method, pathname, body, o, res, sendJson)) return;

        if (await handleSkillsPost(method, pathname, body, o, res, sendJson)) return;
        if (await handleMeetingPost(method, pathname, body, o, res, sendJson)) return;
        if (await handleNotesPost(method, pathname, body, o, res, sendJson)) return;

        if (handleAccountsPost(pathname, body, accountsCtx, res, sendJson)) return;

        if (await handleTicketsPost(method, pathname, body, o, res, sendJson)) return;

        if (await handleSeatsPost(method, pathname, body, o, res, sendJson)) return;

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

/** Cho các file route (src/server/routes/*): tuỳ chọn của createServer và hàm trả JSON. */
export type ServerOpts = Parameters<typeof createServer>[0];
export type SendJson = typeof sendJson;

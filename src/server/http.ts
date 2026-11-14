import { createSystemReader } from './system.ts';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { AGENT_NAME_RE, AVATAR_MAX_BYTES, agentAvatarKey, agentAvatarVerKey, agentNameKey } from '../agents/names.ts';
import type { Socket } from 'node:net';
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { EffortSchema, ModelSchema, type Config, type Seat } from '../config.ts';
import { agentEffortKey, agentModelKey } from '../agents/model.ts';
import { effectiveSeats, seatSettingKey, type Store } from '../store/db.ts';
import { buildSnapshot } from './snapshot.ts';
import { ticketDiff } from './diff.ts';
import { commitAll } from '../git.ts';
import { inboxPath, answerImagePath, detectImage, readInboxFile, removeInboxFromMain } from './inbox.ts';
import { protectedShaKey } from '../core/guard.ts';
import { activeAccountKeys } from '../agents/accounts.ts';
import { handleAccountsGet, handleAccountsPost, IMPORT_MAX_BYTES } from './accounts-api.ts';
import type { AdminExec } from '../isolation/account-admin.ts';
import type { SpawnFn } from '../agents/login-flow.ts';
import type { createMonitor } from '../energy/monitor.ts';
import { approveGoal, type ApproveGoalResult } from '../ticket/goal.ts';
import type { ReleaseInfo } from '../release/publish.ts';
import { readFolders, type ExecAsync } from './folders.ts';
import { archiveGoalAction, restoreGoalAction, purgeGoalAction } from './goal-trash.ts';
import { retryTicket } from './ticket-retry.ts';

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
  retryRelease?(n: number): Promise<ReleaseInfo | null>;
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

      // Thùng rác goal: danh sách goal đã vào thùng rác.
      if (method === 'GET' && pathname === '/api/goals/trash') {
        const project = o.store.getActiveProject();
        const rows = project ? o.store.listArchivedGoals(project) : [];
        sendJson(res, 200, rows.map((g) => ({
          n: g.n, title: g.title, state: g.state, archivedAt: g.archived_at,
          tickets: project ? o.store.listTickets(project, `G${g.n}`).length : 0,
        })));
        return;
      }

      // State snapshot route
      if (method === 'GET' && pathname === '/api/state') {
        const snapshot = buildSnapshot(o.store, o.cfg);
        sendJson(res, 200, snapshot);
        return;
      }

      // Avatar của Worker (chỉ ảnh đã kiểm magic bytes khi lưu; kiểm lại khi trả).
      const avatarMatch = pathname.match(/^\/api\/avatar\/([a-z0-9_-]{1,40})$/);
      if (method === 'GET' && avatarMatch) {
        const agent = avatarMatch[1]!;
        const b64 = Object.hasOwn(o.cfg.agents, agent) ? o.store.getSetting(agentAvatarKey(agent)) : null;
        const buf = b64 ? Buffer.from(b64, 'base64') : null;
        const det = buf ? detectImage(buf) : null;
        if (!buf || !det) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
        res.writeHead(200, { 'Content-Type': det.mime, 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' });
        res.end(buf);
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

      // Plan 6 Task 3: diff ticket + ghi chú dòng
      const ticketDiffMatch = pathname.match(/^\/api\/tickets\/([A-Z][A-Z0-9]*-\d{1,8})\/(diff|notes)$/);
      if (method === 'GET' && ticketDiffMatch) {
        const activeProject = o.store.getActiveProject();
        if (!activeProject) {
          sendJson(res, 404, { error: 'No active project' });
          return;
        }
        const ticketId = ticketDiffMatch[1]!;
        if (ticketDiffMatch[2] === 'notes') {
          sendJson(res, 200, o.store.listLineNotes(activeProject, ticketId));
          return;
        }
        const row = o.store.listTickets(activeProject).find((t) => t.id === ticketId);
        const goal = row ? o.store.getGoal(activeProject, parseInt(row.goal.replace(/^G/, ''), 10)) : null;
        if (!row || !goal) {
          sendJson(res, 404, { error: 'Unknown ticket' });
          return;
        }
        if (!row.base_sha) {
          sendJson(res, 400, { error: 'Ticket has no base yet' });
          return;
        }
        try {
          sendJson(res, 200, ticketDiff(activeProject, row.base_sha, goal.branch, ticketId));
        } catch {
          sendJson(res, 500, { error: 'Diff failed' });
        }
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
        const maxBytes = pathname === '/api/team-note' || /^\/api\/questions\/\d{1,9}\/answer$/.test(pathname) ? 7 * 1024 * 1024 : pathname === '/api/accounts/import' ? IMPORT_MAX_BYTES : pathname === '/api/agent' ? 96 * 1024 : 16384;
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
            sendJson(res, 409, { ok: false, code: 'busy', error: 'Session running', message: 'Session running' });
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
              sendJson(res, 409, { ok: false, code: 'not_ready', error: 'No active project', message: 'No active project' });
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

        // Decision 0006: Push lại main + tag lên GitHub khi lần push sau Approve bị lỗi.
        if (pathname === '/api/goal/push') {
          const parsed = z.object({ goal: z.string().regex(/^G?(\d+)$/i) }).strict().safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: 'Invalid goal format, expected G<n>' });
            return;
          }
          if (o.host.busy?.()) {
            sendJson(res, 409, { error: 'Session running' });
            return;
          }
          if (!o.host.retryRelease) {
            sendJson(res, 501, { error: 'Not implemented' });
            return;
          }
          const info = await o.host.retryRelease(parseInt(parsed.data.goal.replace(/^G/i, ''), 10));
          if (!info) {
            sendJson(res, 409, { error: 'No GitHub release configured for this project' });
            return;
          }
          sendJson(res, info.ok ? 200 : 502, info);
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
            sendJson(res, 409, { error: 'Session running' });
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

        // Thùng rác goal: vào thùng rác / khôi phục / xoá hẳn (có sao lưu). Không cho khi có phiên chạy.
        const trashMatch = pathname.match(/^\/api\/goals\/(\d{1,6})\/(archive|restore|purge)$/);
        if (trashMatch) {
          if (o.host.busy?.()) {
            sendJson(res, 409, { error: 'Session running' });
            return;
          }
          const project = o.store.getActiveProject();
          if (!project) {
            sendJson(res, 400, { error: 'No active project' });
            return;
          }
          const n = parseInt(trashMatch[1]!, 10);
          let result;
          try {
            result = trashMatch[2] === 'archive' ? archiveGoalAction(o.store, project, n)
              : trashMatch[2] === 'restore' ? restoreGoalAction(o.store, project, n)
              : purgeGoalAction(o.store, o.cfg, project, n);
          } catch (err: any) {
            sendJson(res, 500, { error: err?.message || 'Trash action failed' });
            return;
          }
          sendJson(res, result.ok ? 200 : result.status, result);
          return;
        }

        // "Để Finn trả lời": PM trả lời câu hỏi đang mở (một lượt chỉ đọc), trả lời hết thì tự Resume.
        if (pathname === '/api/questions/delegate') {
          if (!o.host.delegateAnswers) {
            sendJson(res, 501, { error: 'Not implemented' });
            return;
          }
          const result = await o.host.delegateAnswers();
          sendJson(res, result.ok ? 200 : (result.status || 400), result);
          return;
        }

        if (pathname === '/api/stop') {
          const StopSchema = z.object({ seat: z.enum(['pm', 'dev', 'qc', 'audit']).optional() }).passthrough();
          const parsed = StopSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: 'Invalid body' });
            return;
          }
          const result = await o.host.stop(parsed.data.seat);
          sendJson(res, result.status ?? 200, result);
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
            sendJson(res, 400, { error: 'No active project' });
            return;
          }

          if (o.host.busy && o.host.busy()) {
            sendJson(res, 409, { error: 'Session running' });
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
          const initialGoal = `Team note N-${createdNoteId}: ${parsed.data.text.slice(0, 200)}`;
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
            if (result.error === 'Session running') {
              sendJson(res, 409, { error: 'Session running' });
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
            await monitor.refresh(activeAccountKeys(o.cfg, o.store), true);
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        // Xoá ghi chú team: dòng DB + file trên main (lịch sử git giữ nguyên). Chỉ khi rảnh.
        if (pathname === '/api/notes/delete') {
          const parsed = z
            .object({ ids: z.array(z.number().int().positive()).min(1).max(500).optional(), all: z.literal(true).optional() })
            .refine((b) => !!b.ids !== !!b.all, 'ids or all')
            .safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: 'Invalid body' });
            return;
          }
          if (o.host.busy?.()) {
            sendJson(res, 409, { error: 'Session running' });
            return;
          }
          const activeProject = o.store.getActiveProject();
          if (!activeProject) {
            sendJson(res, 400, { error: 'No active project' });
            return;
          }
          const picked = parsed.data.all
            ? o.store.listNotes(activeProject, 1_000_000)
            : parsed.data.ids!.map((id) => o.store.getNote(id)).filter((n) => n?.project === activeProject);
          // Ghi chú đang mở của phiên còn chờ/Resume được: phiên đó vẫn đọc note + ảnh → không xoá.
          const inUse = (n: (typeof picked)[number]) => {
            if (n?.status !== 'open' || !n.session_id) return false;
            const st = o.store.getSession(n.session_id)?.status;
            return st === 'running' || st === 'needs_owner' || st === 'stopped' || st === 'out_of_turns';
          };
          const skipped = picked.filter(inUse).map((n) => n!.id);
          const rows = picked.filter((n) => !inUse(n));
          if (rows.length === 0) {
            if (skipped.length) {
              sendJson(res, 409, { error: `Notes in use by a waiting session: ${skipped.map((i) => `N-${i}`).join(', ')}` });
              return;
            }
            sendJson(res, 404, { error: 'No notes' });
            return;
          }
          const names = rows.flatMap((n) => [`N-${n!.id}.md`, ...(n!.image ? [n!.image] : [])]);
          const pinKey = protectedShaKey(activeProject);
          let result: { mainSha: string; removed: string[] };
          try {
            result = removeInboxFromMain(activeProject, names, o.cfg.git?.protected_branch || 'main', o.store.getSetting(pinKey)?.trim() || '');
          } catch (err: any) {
            const msg = String(err?.message || err);
            sendJson(res, 409, { error: msg === 'dirty' ? 'Working tree is dirty' : msg === 'protected_branch_moved' ? 'protected_branch_moved' : 'Delete failed' });
            return;
          }
          o.store.setSetting(pinKey, result.mainSha);
          for (const n of rows) o.store.deleteNote(n!.id);
          sendJson(res, 200, { ok: true, deleted: rows.map((n) => n!.id), skipped, removed: result.removed });
          return;
        }

        if (handleAccountsPost(pathname, body, accountsCtx, res, sendJson)) return;

        // Nút "Làm lại ticket": failed/blocked → returned (đủ vòng sửa mới), gỡ ticket bị chặn dây chuyền.
        const retryMatch = pathname.match(/^\/api\/tickets\/([A-Z][A-Z0-9]*-\d{1,8})\/retry$/);
        if (retryMatch) {
          if (o.host.busy?.()) {
            sendJson(res, 409, { error: 'Session running' });
            return;
          }
          const project = o.store.getActiveProject();
          if (!project) {
            sendJson(res, 400, { error: 'No active project' });
            return;
          }
          const result = retryTicket(o.store, project, retryMatch[1]!);
          sendJson(res, result.ok ? 200 : result.status, result);
          return;
        }

        // Plan 6 Task 3: ghi chú dòng + trả ticket về Dev
        const ticketPostMatch = pathname.match(/^\/api\/tickets\/([A-Z][A-Z0-9]*-\d{1,8})\/(notes|return)$/);
        if (ticketPostMatch) {
          if (ticketPostMatch[2] === 'return' && o.host.busy?.()) {
            sendJson(res, 409, { error: 'Session running' });
            return;
          }
          const activeProject = o.store.getActiveProject();
          if (!activeProject) {
            sendJson(res, 400, { error: 'No active project' });
            return;
          }
          const ticketId = ticketPostMatch[1]!;
          const row = o.store.listTickets(activeProject).find((t) => t.id === ticketId);
          const goalN = row ? parseInt(row.goal.replace(/^G/, ''), 10) : NaN;
          const goal = row ? o.store.getGoal(activeProject, goalN) : null;
          if (!row || !goal) {
            sendJson(res, 404, { error: 'Unknown ticket' });
            return;
          }
          if (ticketPostMatch[2] === 'notes') {
            const parsed = z.object({
              path: z.string().min(1).max(500),
              line: z.number().int().min(1).max(10_000_000),
              text: z.string().trim().min(1).max(1000),
            }).strict().safeParse(body);
            if (!parsed.success) {
              sendJson(res, 400, { error: 'Invalid note' });
              return;
            }
            const id = o.store.addLineNote(activeProject, ticketId, parsed.data.path, parsed.data.line, parsed.data.text);
            sendJson(res, 200, { ok: true, id });
            return;
          }
          if (goal.state === 'approved' || goal.state === 'merged') {
            sendJson(res, 409, { error: 'Goal already merged' });
            return;
          }
          if (!['passed', 'returned', 'failed'].includes(row.state)) {
            sendJson(res, 409, { error: `Ticket is ${row.state}` });
            return;
          }
          const waiting = o.store.getLatestSession('needs_owner', activeProject) ?? o.store.getLatestSession('awaiting_approval', activeProject);
          if (waiting) {
            sendJson(res, 409, { error: 'Another session is waiting – resume or finish it first' });
            return;
          }
          if (o.store.listLineNotes(activeProject, ticketId, true).length === 0) {
            sendJson(res, 400, { error: 'Add a note first' });
            return;
          }
          // Anh trả về: cấp lại đủ vòng sửa.
          o.store.setTicketState(activeProject, ticketId, 'returned', 'owner', 'owner_line_notes', 0, row.base_sha);
          o.store.setGoalState(activeProject, goalN, 'in_progress', 'owner', `ticket ${ticketId} returned`);
          // Phiên mới cho goal ở needs_owner: anh bấm Resume là Dev làm lại với ghi chú.
          const sid = o.store.createSession([String(goalN)], activeProject);
          o.store.setSessionStatus(sid, 'needs_owner');
          sendJson(res, 200, { ok: true, sessionId: sid });
          return;
        }

        // Plan 6 Task 4: anh trả lời câu hỏi chặn ticket
        const answerMatch = pathname.match(/^\/api\/questions\/(\d{1,9})\/answer$/);
        if (answerMatch) {
          const parsed = z.object({
            text: z.string().trim().min(1).max(2000),
            image: z.object({ base64: z.string().min(1).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict().optional(),
          }).strict().safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: 'Invalid answer' });
            return;
          }
          const q = o.store.getQuestion(parseInt(answerMatch[1]!, 10));
          const activeProject = o.store.getActiveProject();
          if (!q || q.project !== activeProject) {
            sendJson(res, 404, { error: 'Unknown question' });
            return;
          }
          if (q.state !== 'open') {
            sendJson(res, 409, { error: 'Already answered' });
            return;
          }
          // Ảnh kèm câu trả lời: cùng luật với ảnh Team note (≤ 5 MB, png/jpg/webp theo nội dung file).
          let imageName: string | null = null;
          if (parsed.data.image) {
            const imgBuf = Buffer.from(parsed.data.image.base64, 'base64');
            if (imgBuf.length > 5 * 1024 * 1024) {
              sendJson(res, 413, { error: 'Image exceeds 5 MB limit' });
              return;
            }
            const detected = detectImage(imgBuf);
            if (!detected) {
              sendJson(res, 415, { error: 'Unsupported image format' });
              return;
            }
            imageName = `Q-${q.id}.${detected.ext}`;
            try {
              writeFileSync(answerImagePath(activeProject, imageName), imgBuf);
            } catch (err: any) {
              sendJson(res, 400, { error: err?.message || 'Cannot save image' });
              return;
            }
          }
          o.store.answerQuestion(q.id, parsed.data.text, imageName);
          sendJson(res, 200, { ok: true });
          return;
        }

        if (pathname === '/api/agent') {
          const AgentBodySchema = z.object({
            agent: z.string(),
            model: z.union([z.literal(''), ModelSchema]).optional(),
            effort: EffortSchema.optional(),
            name: z.string().transform((x) => x.trim()).refine((x) => x === '' || AGENT_NAME_RE.test(x)).optional(),
            avatar: z.string().max(Math.ceil(AVATAR_MAX_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(),
          }).strict();
          const parsed = AgentBodySchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: 'Invalid model, effort or name' });
            return;
          }
          const { agent, model, effort, name, avatar } = parsed.data;
          if (!Object.hasOwn(o.cfg.agents, agent)) {
            sendJson(res, 400, { error: `Unknown agent "${agent}"` });
            return;
          }
          // Đổi tên chỉ là hiển thị: được đổi cả lúc phiên đang chạy. '' = về tên gốc.
          if ((name !== undefined || avatar !== undefined) && model === undefined && effort === undefined) {
            if (avatar !== undefined && avatar !== '' && !detectImage(Buffer.from(avatar, 'base64'))) {
              sendJson(res, 400, { error: 'Avatar must be PNG, JPEG or WebP' });
              return;
            }
            if (name !== undefined) o.store.setSetting(agentNameKey(agent), name);
            if (avatar !== undefined) {
              o.store.setSetting(agentAvatarKey(agent), avatar);
              o.store.setSetting(agentAvatarVerKey(agent), avatar ? String(Date.now()) : '');
            }
            sendJson(res, 200, { ok: true, agent });
            return;
          }
          if (o.host.busy?.()) {
            sendJson(res, 409, { error: 'Session running' });
            return;
          }
          if (model !== undefined) o.store.setSetting(agentModelKey(agent), model);
          if (effort !== undefined) o.store.setSetting(agentEffortKey(agent), effort);
          sendJson(res, 200, { ok: true, agent, model: model ?? null, effort: effort ?? null });
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
            sendJson(res, 409, { error: 'Session running' });
            return;
          }
          const { seat, agent } = parsed.data;
          if (!Object.hasOwn(o.cfg.seats, seat)) {
            sendJson(res, 400, { error: `Invalid seat "${seat}"` });
            return;
          }
          if (!Object.hasOwn(o.cfg.agents, agent)) {
            sendJson(res, 400, { error: `${agent} can't sit in ${seat}` });
            return;
          }
          const agentCfg = o.cfg.agents[agent];
          if (!agentCfg || !agentCfg.can_sit.includes(seat as Seat)) {
            sendJson(res, 400, { error: `${agent} can't sit in ${seat}` });
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
            o.store.setSetting(seatSettingKey(o.store.getActiveProject(), seat as Seat), agent);
            console.log(`${seat} seat: ${current} → ${agent}`);
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

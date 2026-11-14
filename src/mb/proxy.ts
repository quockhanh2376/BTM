// Cổng trung gian của Boss (MB) – decision 0003: agent chỉ cầm mã tạm của lượt; cổng (chỉ 127.0.0.1) kiểm mã,
// thay bằng key Z.ai thật rồi chuyển tiếp, phản hồi (kể cả stream SSE) pipe nguyên về.
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { mbStatus, readMbKey } from './vault.ts';

type Settings = { getSetting(key: string): string | null; setSetting(key: string, value: string): void };

export const ZAI_BASE_URL = 'https://api.z.ai/api/anthropic';
export const MB_PROXY_PORT = 8099;

const tokens = new Map<string, number>(); // mã tạm → hết hạn (ms)

export function issueTurnToken(ttlMs: number, now = Date.now()): string {
  for (const [t, exp] of tokens) if (exp <= now) tokens.delete(t);
  const t = `btm-turn-${randomBytes(24).toString('hex')}`;
  tokens.set(t, now + ttlMs);
  return t;
}

export function revokeTurnToken(t: string): void {
  tokens.delete(t);
}

export function tokenValid(t: string | undefined, now = Date.now()): boolean {
  const exp = t ? tokens.get(t) : undefined;
  return exp !== undefined && exp > now;
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization', 'x-api-key']);

export interface ProxyOpts { store: Settings; dataDir: string; port?: number; upstream?: string }

export function createMbProxy(o: ProxyOpts): http.Server {
  const up = new URL(o.upstream ?? ZAI_BASE_URL);
  const client = up.protocol === 'http:' ? http : https;
  return http.createServer((req, res) => {
    const deny = (code: number, msg: string) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: msg } }));
    };
    const auth = String(req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-api-key'] ?? '');
    if (!tokenValid(token)) return deny(401, 'btm: turn token invalid or expired');
    if (!mbStatus(o.store).enabled) return deny(401, 'btm: Boss is turned off');
    const key = readMbKey(o.store, o.dataDir);
    if (!key) return deny(401, 'btm: Boss key not set');

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
    headers.authorization = `Bearer ${key}`;
    headers.host = up.host;
    const path = up.pathname.replace(/\/$/, '') + (req.url ?? '/');
    const out = client.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method: req.method, path, headers }, (r) => {
      const h: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k) && v !== undefined) h[k] = v;
      res.writeHead(r.statusCode ?? 502, h);
      r.pipe(res);
    });
    out.on('error', () => (res.headersSent ? res.destroy() : deny(502, 'btm: upstream error')));
    req.pipe(out);
  });
}

export function startMbProxy(o: ProxyOpts): http.Server {
  const s = createMbProxy(o);
  s.on('error', (e) => console.error(`mb_proxy_error: ${(e as Error).message}`));
  s.listen(o.port ?? MB_PROXY_PORT, '127.0.0.1');
  return s;
}

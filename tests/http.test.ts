import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import http, { type Server } from 'node:http';
import { openStore, type Store } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createServer, type HostApi } from '../src/server/http.ts';

function startServer(server: Server): Promise<number> {
  return new Promise((res, rej) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        res(addr.port);
      } else {
        rej(new Error('Failed to obtain server address'));
      }
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((res) => {
    server.close(() => res());
  });
}

describe('HTTP Server & SSE', () => {
  let store: Store;
  let cfg: Config;
  let server: Server;
  let port: number;
  let baseUrl: string;
  let webFile: string;

  let host: HostApi & {
    startCalls: string[][];
    approveCalls: number;
    stopCalls: number;
    commandCalls: { to: string; text: string }[];
  };

  beforeEach(async () => {
    store = openStore(':memory:');
    cfg = loadConfig('btm.config.yaml');
    webFile = resolve(__dirname, '../web/index.html');

    host = {
      startCalls: [],
      approveCalls: 0,
      stopCalls: 0,
      commandCalls: [],
      async start(goals: string[]) {
        host.startCalls.push(goals);
        return { ok: true };
      },
      async approve() {
        host.approveCalls++;
        return { ok: true };
      },
      stop() {
        host.stopCalls++;
        return { ok: true };
      },
      command(to, text) {
        host.commandCalls.push({ to, text });
        return { ok: true, id: 1 };
      },
    };

    server = createServer({
      cfg,
      store,
      host,
      webFile,
      pollMs: 50,
    });

    port = await startServer(server);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await stopServer(server);
    store.close();
  });

  describe('Static route GET /', () => {
    it('serves web/index.html with UTF-8 and CSP headers', async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('content-type')).toContain('charset=utf-8');
      expect(res.headers.get('content-security-policy')).toBe(
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
      );
      const text = await res.text();
      expect(text).toContain('BTM Dashboard');
    });
  });

  describe('GET /api/state', () => {
    it('returns the current snapshot as JSON', async () => {
      const res = await fetch(`${baseUrl}/api/state`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const data = await res.json();
      expect(data).toHaveProperty('project');
      expect(data).toHaveProperty('session');
      expect(data).toHaveProperty('holder');
      expect(data).toHaveProperty('seats');
      expect(data).toHaveProperty('tasks');
      expect(data).toHaveProperty('log');
      expect(data).toHaveProperty('queue');
    });
  });

  describe('GET /api/events (SSE)', () => {
    it('sends immediate state event, and sends update when store changes', async () => {
      const res = await fetch(`${baseUrl}/api/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      async function readNextEvent(timeoutMs = 1500): Promise<string> {
        let buffer = '';
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
          const raceResult = await Promise.race([
            reader.read(),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), timeoutMs - (Date.now() - startTime))
            ),
          ]);
          if (!raceResult || raceResult.done) break;
          buffer += decoder.decode(raceResult.value, { stream: true });
          if (buffer.includes('\n\n')) {
            return buffer;
          }
        }
        return buffer;
      }

      // First event immediately sent
      const firstEvent = await readNextEvent();
      expect(firstEvent).toContain('event: state');
      expect(firstEvent).toContain('data: {');

      // Now update store
      store.enqueue('dev', 'Run tests');

      // Second event should arrive after poll
      const secondEvent = await readNextEvent();
      expect(secondEvent).toContain('event: state');
      expect(secondEvent).toContain('Run tests');

      // Without store changes, no extra event should arrive
      const thirdEvent = await readNextEvent(120);
      expect(thirdEvent).toBe('');

      await reader.cancel();
    });

    it('server.close() resolves cleanly when an SSE client is still connected', async () => {
      const sseServer = createServer({
        cfg,
        store,
        host,
        webFile,
        pollMs: 50,
      });
      const ssePort = await startServer(sseServer);
      const res = await fetch(`http://127.0.0.1:${ssePort}/api/events`);
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const firstChunk = await reader.read();
      expect(firstChunk.value).toBeDefined();

      // Close server while SSE client is still connected
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server.close() timed out')), 2000);
        sseServer.close((err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        });
      });
    });

    it('sends : ping periodically based on pingMs option', async () => {
      const pingServer = createServer({
        cfg,
        store,
        host,
        webFile,
        pollMs: 500,
        pingMs: 40,
      });
      const pingPort = await startServer(pingServer);

      const res = await fetch(`http://127.0.0.1:${pingPort}/api/events`);
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const startTime = Date.now();
      while (Date.now() - startTime < 1500) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.includes(': ping\n\n')) {
          break;
        }
      }
      expect(buffer).toContain(': ping\n\n');
      await reader.cancel();
      await stopServer(pingServer);
    });

    it('cleans up intervals when SSE client disconnects', async () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const ac = new AbortController();
      const res = await fetch(`${baseUrl}/api/events`, { signal: ac.signal });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read();

      ac.abort();
      await new Promise((r) => setTimeout(r, 100));

      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });
  });

  describe('POST guard rules', () => {
    it('returns 403 when x-btm header is missing', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goals: ['Goal 1'] }),
      });
      expect(res.status).toBe(403);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 403 when x-btm header is not 1', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '2',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goals: ['Goal 1'] }),
      });
      expect(res.status).toBe(403);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 403 when Origin is untrusted (evil CSRF)', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: 'https://evil.example',
        },
        body: JSON.stringify({ goals: ['Goal 1'] }),
      });
      expect(res.status).toBe(403);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 403 when Origin has wrong port', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: 'http://127.0.0.1:9999',
        },
        body: JSON.stringify({ goals: ['Goal 1'] }),
      });
      expect(res.status).toBe(403);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 415 when content-type is missing', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goals: ['Goal 1'] }),
      });
      expect(res.status).toBe(415);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 415 when content-type is text/plain', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'text/plain',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goals: ['Goal 1'] }),
      });
      expect(res.status).toBe(415);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 415 when content-type is application/jsonp', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/jsonp',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goals: ['Goal 1'] }),
      });
      expect(res.status).toBe(415);
      expect(host.startCalls.length).toBe(0);
    });

    it('accepts content-type with parameters like application/json; charset=utf-8', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json; charset=utf-8',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goals: ['Goal 1'] }),
      });
      expect(res.status).toBe(200);
      expect(host.startCalls.length).toBe(1);
    });

    it('returns 403 when Origin has trailing slash', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}/`,
        },
        body: JSON.stringify({ goals: ['Goal 1'] }),
      });
      expect(res.status).toBe(403);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 403 when Origin is empty string', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: '',
        },
        body: JSON.stringify({ goals: ['Goal 1'] }),
      });
      expect(res.status).toBe(403);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 413 when body exceeds 16 KB (e.g. 20 KB)', async () => {
      const hugeString = 'x'.repeat(20 * 1024);
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goals: [hugeString] }),
      });
      expect(res.status).toBe(413);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 413 when body chunked exceeds 16 KB', async () => {
      const res = await new Promise<{ statusCode?: number }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/session',
            method: 'POST',
            headers: {
              'x-btm': '1',
              'content-type': 'application/json',
              Origin: `http://127.0.0.1:${port}`,
              'Transfer-Encoding': 'chunked',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve({ statusCode: res.statusCode }));
          }
        );
        req.on('error', reject);
        req.write('{"goals":["' + 'a'.repeat(10 * 1024));
        req.write('b'.repeat(10 * 1024) + '"]}');
        req.end();
      });
      expect(res.statusCode).toBe(413);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 400 when body is empty string', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: '',
      });
      expect(res.status).toBe(400);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 400 on malformed JSON body', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: '{ malformed json',
      });
      expect(res.status).toBe(400);
      expect(host.startCalls.length).toBe(0);
    });
  });

  describe('POST /api/session', () => {
    it('returns 400 when goals is empty array', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goals: [] }),
      });
      expect(res.status).toBe(400);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 400 when goals count exceeds max_goals (4 > 3)', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goals: ['G1', 'G2', 'G3', 'G4'] }),
      });
      expect(res.status).toBe(400);
      expect(host.startCalls.length).toBe(0);
    });

    it('returns 200 and calls host.start on valid payload', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goals: ['Goal 1', 'Goal 2'] }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(host.startCalls).toEqual([['Goal 1', 'Goal 2']]);
    });

    it('accepts localhost Origin as valid', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://localhost:${port}`,
        },
        body: JSON.stringify({ goals: ['Goal 1'] }),
      });
      expect(res.status).toBe(200);
      expect(host.startCalls.length).toBe(1);
    });

    it('accepts request without Origin header if x-btm is present', async () => {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ goals: ['Goal 1'] }),
      });
      expect(res.status).toBe(200);
      expect(host.startCalls.length).toBe(1);
    });
  });

  describe('POST /api/approve', () => {
    it('calls host.approve() and returns 200', async () => {
      const res = await fetch(`${baseUrl}/api/approve`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(host.approveCalls).toBe(1);
    });

    it('returns 400 when body is empty string and does not call host.approve', async () => {
      const res = await fetch(`${baseUrl}/api/approve`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: '',
      });
      expect(res.status).toBe(400);
      expect(host.approveCalls).toBe(0);
    });

    it('returns 400 when body is malformed JSON and does not call host.approve', async () => {
      const res = await fetch(`${baseUrl}/api/approve`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: '{bad',
      });
      expect(res.status).toBe(400);
      expect(host.approveCalls).toBe(0);
    });
  });

  describe('POST /api/stop', () => {
    it('calls host.stop() and returns 200', async () => {
      const res = await fetch(`${baseUrl}/api/stop`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(host.stopCalls).toBe(1);
    });

    it('returns 400 when body is empty string and does not call host.stop', async () => {
      const res = await fetch(`${baseUrl}/api/stop`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: '',
      });
      expect(res.status).toBe(400);
      expect(host.stopCalls).toBe(0);
    });

    it('returns 400 when body is malformed JSON and does not call host.stop', async () => {
      const res = await fetch(`${baseUrl}/api/stop`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: '{bad',
      });
      expect(res.status).toBe(400);
      expect(host.stopCalls).toBe(0);
    });
  });

  describe('POST /api/command', () => {
    it('returns 400 when recipient is invalid', async () => {
      const res = await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ to: 'unknown', text: 'do something' }),
      });
      expect(res.status).toBe(400);
      expect(host.commandCalls.length).toBe(0);
    });

    it('returns 400 when text is empty', async () => {
      const res = await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ to: 'dev', text: '' }),
      });
      expect(res.status).toBe(400);
      expect(host.commandCalls.length).toBe(0);
    });

    it('returns 400 when text exceeds 2000 chars', async () => {
      const res = await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ to: 'pm', text: 'a'.repeat(2001) }),
      });
      expect(res.status).toBe(400);
      expect(host.commandCalls.length).toBe(0);
    });

    it('calls host.command and returns 200 on valid input', async () => {
      const res = await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ to: 'dev', text: 'Fix bug in login' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ ok: true, id: 1 });
      expect(host.commandCalls).toEqual([{ to: 'dev', text: 'Fix bug in login' }]);
    });
  });

  describe('Unknown routes', () => {
    it('returns 404 for unknown GET route', async () => {
      const res = await fetch(`${baseUrl}/unknown`);
      expect(res.status).toBe(404);
    });

    it('returns 404 for unknown POST route with valid guard', async () => {
      const res = await fetch(`${baseUrl}/api/unknown`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http, { type Server } from 'node:http';
import { openStore, type Store } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createServer, type HostApi } from '../src/server/http.ts';
import * as gitModule from '../src/git.ts';
import { readdirSync } from 'node:fs';
import { tmpRepo } from './helpers.ts';
import { execFileSync } from 'node:child_process';

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
    startOpts: any[];
    approveCalls: number;
    resumeCalls: number;
    stopCalls: number;
    commandCalls: { to: string; text: string }[];
    autoApproveCalls: boolean[];
    approveGoalCalls: number[];
  };

  beforeEach(async () => {
    store = openStore(':memory:');
    cfg = loadConfig('btm.config.yaml');
    webFile = resolve(__dirname, '../web/index.html');

    host = {
      startCalls: [],
      startOpts: [],
      approveCalls: 0,
      resumeCalls: 0,
      stopCalls: 0,
      commandCalls: [],
      autoApproveCalls: [],
      approveGoalCalls: [],
      approveGoal(n: number) {
        host.approveGoalCalls.push(n);
        return { ok: true, sha: 'merge-sha-123' };
      },
      async start(goals: string[], opts?: any) {
        if (opts?.prepare) {
          try {
            const res = await opts.prepare();
            if (res?.noteId) {
              goals = goals.map((g) => g.replace('N-?', `N-${res.noteId}`));
            }
          } catch (err: any) {
            return { ok: false, error: err?.message || String(err) };
          }
        }
        host.startCalls.push(goals);
        host.startOpts.push(opts);
        return { ok: true };
      },
      async approve() {
        host.approveCalls++;
        return { ok: true };
      },
      async resume() {
        host.resumeCalls++;
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
      setAutoApprove(autoApprove: boolean) {
        host.autoApproveCalls.push(autoApprove);
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
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' blob: data:"
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
      expect(data).toHaveProperty('goals');
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

  describe('POST /api/resume', () => {
    it('calls host.resume() and returns 200', async () => {
      const res = await fetch(`${baseUrl}/api/resume`, {
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
      expect(host.resumeCalls).toBe(1);
    });

    it('returns 400 when body is empty string and does not call host.resume', async () => {
      const res = await fetch(`${baseUrl}/api/resume`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: '',
      });
      expect(res.status).toBe(400);
      expect(host.resumeCalls).toBe(0);
    });

    it('returns 400 when body is malformed JSON and does not call host.resume', async () => {
      const res = await fetch(`${baseUrl}/api/resume`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: '{bad',
      });
      expect(res.status).toBe(400);
      expect(host.resumeCalls).toBe(0);
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

  describe('POST /api/settings', () => {
    it('rejects without x-btm header (403)', async () => {
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ autoApprove: true }),
      });
      expect(res.status).toBe(403);
      expect(host.autoApproveCalls.length).toBe(0);
    });

    it('rejects invalid Origin (403)', async () => {
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: 'http://malicious.example.com',
        },
        body: JSON.stringify({ autoApprove: true }),
      });
      expect(res.status).toBe(403);
      expect(host.autoApproveCalls.length).toBe(0);
    });

    it('rejects invalid body schema (400)', async () => {
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ autoApprove: 'not-a-boolean' }),
      });
      expect(res.status).toBe(400);
      expect(host.autoApproveCalls.length).toBe(0);
    });

    it('calls host.setAutoApprove and returns 200 on valid input', async () => {
      const res1 = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ autoApprove: true }),
      });
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1).toMatchObject({ ok: true });
      expect(host.autoApproveCalls).toEqual([true]);

      const res2 = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ autoApprove: false }),
      });
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2).toMatchObject({ ok: true });
      expect(host.autoApproveCalls).toEqual([true, false]);
    });
  });

  describe('POST /api/energy/refresh', () => {
    it('rejects without x-btm header (403)', async () => {
      const res = await fetch(`${baseUrl}/api/energy/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });

    it('rejects with untrusted origin (403)', async () => {
      const res = await fetch(`${baseUrl}/api/energy/refresh`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: 'https://attacker.example',
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });

    it('rejects with non-json content-type (415)', async () => {
      const res = await fetch(`${baseUrl}/api/energy/refresh`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'text/plain',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: 'hello',
      });
      expect(res.status).toBe(415);
    });

    it('calls monitor.refresh(allAgents, true) and returns 200', async () => {
      const refreshCalls: Array<{ agents: string[]; force?: boolean }> = [];
      const monitor = {
        async refresh(agents: string[], force?: boolean) {
          refreshCalls.push({ agents, force });
        },
        gate: vi.fn(),
      };
      (host as any).monitor = monitor;

      const res = await fetch(`${baseUrl}/api/energy/refresh`, {
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
      expect(refreshCalls).toEqual([
        {
          agents: Object.keys(cfg.agents),
          force: true,
        },
      ]);
    });
  });

  describe('P6-T3/T4: ghi chú dòng, trả ticket về Dev, trả lời câu hỏi', () => {
    const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'x-btm': '1', 'content-type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify(body),
    });
    function seed() {
      const project = '/tmp/btm-http-p6';
      store.setActiveProject(project);
      const g = store.createGoal(project, 'Goal');
      store.upsertTicket(project, { id: 'GTM-0001', goal: `G${g.n}`, number: 1, of: 1, title: 'T', type: 'feat', size: 'S', scope: ['src/'], acceptance: ['a'], done_when: 'd' } as any);
      store.setTicketState(project, 'GTM-0001', 'passed', 'jenny', 'qc passed', 0, 'abc1234');
      store.setGoalState(project, g.n, 'qc_done', 'core', 'all passed');
      return { project, n: g.n };
    }
    it('ghi chú: lưu + đọc lại; dữ liệu sai → 400; ticket lạ → 404', async () => {
      const { project } = seed();
      expect((await post('/api/tickets/GTM-0001/notes', { path: 'src/a.ts', line: 3, text: 'đổi tên' })).status).toBe(200);
      expect((await post('/api/tickets/GTM-0001/notes', { path: 'src/a.ts', line: 0, text: 'x' })).status).toBe(400);
      expect((await post('/api/tickets/GTM-0001/notes', { path: 'src/a.ts', line: 1, text: 'x'.repeat(1001) })).status).toBe(400);
      expect((await post('/api/tickets/GTM-0099/notes', { path: 'a', line: 1, text: 'x' })).status).toBe(404);
      const list = await (await fetch(`${baseUrl}/api/tickets/GTM-0001/notes`, { headers: { 'x-btm': '1' } })).json();
      expect(list.map((n: any) => [n.path, n.line, n.text])).toEqual([['src/a.ts', 3, 'đổi tên']]);
      expect(store.listLineNotes(project, 'GTM-0001', true)).toHaveLength(1);
    });
    it('Return to Dev: cần ghi chú; ticket returned, goal in_progress, phiên needs_owner mới; đang chạy → 409', async () => {
      const { project, n } = seed();
      expect((await post('/api/tickets/GTM-0001/return', {})).status).toBe(400);
      store.addLineNote(project, 'GTM-0001', 'src/a.ts', 1, 'sửa');
      const r = await post('/api/tickets/GTM-0001/return', {});
      expect(r.status).toBe(200);
      const { sessionId } = await r.json();
      expect(store.getTicketState(project, 'GTM-0001')?.state).toBe('returned');
      expect(store.getGoal(project, n)?.state).toBe('in_progress');
      expect(store.getSession(sessionId)?.status).toBe('needs_owner');
      expect(store.getTicketState(project, 'GTM-0001')?.fix_rounds).toBe(0);
      // phiên needs_owner vừa tạo đang chờ → trả về lần nữa bị từ chối, không chồng phiên
      store.setTicketState(project, 'GTM-0001', 'passed', 'jenny', 'qc passed');
      store.addLineNote(project, 'GTM-0001', 'src/a.ts', 2, 'nữa');
      expect((await post('/api/tickets/GTM-0001/return', {})).status).toBe(409);
      host.busy = vi.fn().mockReturnValue(true);
      expect((await post('/api/tickets/GTM-0001/return', {})).status).toBe(409);
    });
    it('Return từ chối ticket chưa xong (in_dev)', async () => {
      const { project } = seed();
      store.setTicketState(project, 'GTM-0001', 'in_dev', 'jacky', 'dev');
      store.addLineNote(project, 'GTM-0001', 'src/a.ts', 1, 'x');
      expect((await post('/api/tickets/GTM-0001/return', {})).status).toBe(409);
    });
    it('trả lời câu hỏi: lần đầu ok, lần hai 409, câu hỏi project khác 404', async () => {
      const { project } = seed();
      const id = store.addQuestion(project, 'GTM-0001', 'dev', 'jacky', 'SQLite?');
      const other = store.addQuestion('/other', 'X-0001', 'dev', 'jacky', 'q');
      expect((await post(`/api/questions/${id}/answer`, { text: 'Yes' })).status).toBe(200);
      expect(store.getQuestion(id)?.answer).toBe('Yes');
      expect((await post(`/api/questions/${id}/answer`, { text: 'No' })).status).toBe(409);
      expect((await post(`/api/questions/${other}/answer`, { text: 'x' })).status).toBe(404);
      expect((await post(`/api/questions/${id}/answer`, { text: '' })).status).toBe(400);
    });
    it('trả lời câu hỏi kèm ảnh: lưu .git/btm-answers/Q-<id>.png (ngoài cây git); ảnh sai định dạng 415, quá 5 MB 413', async () => {
      const project = tmpRepo({ 'README.md': 'x' });
      store.setActiveProject(project);
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
      const bad = store.addQuestion(project, 'GTM-0001', 'qc', 'jenny', 'ảnh?');
      expect((await post(`/api/questions/${bad}/answer`, { text: 'x', image: { base64: Buffer.from('hello').toString('base64') } })).status).toBe(415);
      expect((await post(`/api/questions/${bad}/answer`, { text: 'x', image: { base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') } })).status).toBe(413);
      expect(store.getQuestion(bad)?.state).toBe('open');
      const id = store.addQuestion(project, 'GTM-0001', 'qc', 'jenny', 'Cần ảnh?');
      expect((await post(`/api/questions/${id}/answer`, { text: 'Xem ảnh', image: { base64: png.toString('base64') } })).status).toBe(200);
      expect(store.getQuestion(id)?.image).toBe(`Q-${id}.png`);
      expect(readFileSync(join(project, '.git', 'btm-answers', `Q-${id}.png`)).equals(png)).toBe(true);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' })).toBe('');
    });
  });

  describe('P5-T5: POST /api/agent (model + effort theo agent)', () => {
    const post = (body: unknown) => fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'x-btm': '1', 'content-type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify(body),
    });
    it('lưu model + effort vào setting; model rỗng = mặc định CLI', async () => {
      const r = await post({ agent: 'jacky', model: 'gemini-3.8-flash-high', effort: 'high' });
      expect(r.status).toBe(200);
      expect(store.getSetting('agent_model:jacky')).toBe('gemini-3.8-flash-high');
      expect(store.getSetting('agent_effort:jacky')).toBe('high');
      expect((await post({ agent: 'jacky', model: '' })).status).toBe(200);
      expect(store.getSetting('agent_model:jacky')).toBe('');
    });
    it('model lạ, effort lạ, agent lạ → 400; Codex xhigh được; đang chạy → 409', async () => {
      expect((await post({ agent: 'jacky', model: 'x;rm -rf /' })).status).toBe(400);
      expect((await post({ agent: 'jacky', effort: 'ultra' })).status).toBe(400);
      expect((await post({ agent: 'ghost', effort: 'low' })).status).toBe(400);
      expect((await post({ agent: 'jenny', effort: 'xhigh' })).status).toBe(200);
      host.busy = vi.fn().mockReturnValue(true);
      expect((await post({ agent: 'jacky', effort: 'low' })).status).toBe(409);
      expect(store.getSetting('agent_effort:jacky')).toBeNull();
    });
    it('đổi tên hiển thị: được cả khi đang chạy; tên lạ → 400; rỗng = về mặc định', async () => {
      host.busy = vi.fn().mockReturnValue(true);
      expect((await post({ agent: 'jacky', name: '  David Nguyễn ' })).status).toBe(200);
      expect(store.getSetting('agent_name:jacky')).toBe('David Nguyễn');
      expect((await post({ agent: 'jacky', name: '<img src=x>' })).status).toBe(400);
      expect((await post({ agent: 'jacky', name: 'x'.repeat(25) })).status).toBe(400);
      expect((await post({ agent: 'ghost', name: 'Bob' })).status).toBe(400);
      expect((await post({ agent: 'jacky', name: 'Bob', effort: 'low' })).status).toBe(409);
      expect((await post({ agent: 'jacky', name: '' })).status).toBe(200);
      expect(store.getSetting('agent_name:jacky')).toBe('');
    });
    it('avatar: chỉ PNG/JPEG/WebP; GET /api/avatar/<agent> trả đúng ảnh + nosniff; rỗng = bỏ', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      expect((await post({ agent: 'jacky', avatar: Buffer.from('<svg onload=x>').toString('base64') })).status).toBe(400);
      expect((await post({ agent: 'jacky', avatar: 'not base64!' })).status).toBe(400);
      expect((await post({ agent: 'jacky', avatar: png.toString('base64') })).status).toBe(200);
      expect(store.getSetting('agent_avatar_v:jacky')).toMatch(/^\d+$/);
      const g = await fetch(`${baseUrl}/api/avatar/jacky`);
      expect(g.status).toBe(200);
      expect(g.headers.get('content-type')).toBe('image/png');
      expect(g.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await g.arrayBuffer()).equals(png)).toBe(true);
      expect((await fetch(`${baseUrl}/api/avatar/ghost`)).status).toBe(404);
      expect((await post({ agent: 'jacky', avatar: '' })).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/avatar/jacky`)).status).toBe(404);
      expect(store.getSetting('agent_avatar_v:jacky')).toBe('');
    });
  });

  describe('POST /api/seat', () => {
    it('returns 409 when host is busy', async () => {
      host.busy = vi.fn().mockReturnValue(true);
      const res = await fetch(`${baseUrl}/api/seat`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ seat: 'dev', agent: 'jenny' }),
      });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it('returns 400 when seat is invalid', async () => {
      const res = await fetch(`${baseUrl}/api/seat`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ seat: 'architect', agent: 'jacky' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when agent cannot sit in seat', async () => {
      // In btm.config.yaml: elon has can_sit: ['pm', 'qc'], not 'dev'
      const res = await fetch(`${baseUrl}/api/seat`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ seat: 'dev', agent: 'elon' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when agent does not exist', async () => {
      const res = await fetch(`${baseUrl}/api/seat`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ seat: 'dev', agent: 'unknown_agent' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects prototype properties __proto__, constructor, toString with 400', async () => {
      for (const dangerous of ['__proto__', 'constructor', 'toString']) {
        const resSeat = await fetch(`${baseUrl}/api/seat`, {
          method: 'POST',
          headers: {
            'x-btm': '1',
            'content-type': 'application/json',
            Origin: `http://127.0.0.1:${port}`,
          },
          body: JSON.stringify({ seat: dangerous, agent: 'jenny' }),
        });
        expect(resSeat.status).toBe(400);

        const resAgent = await fetch(`${baseUrl}/api/seat`, {
          method: 'POST',
          headers: {
            'x-btm': '1',
            'content-type': 'application/json',
            Origin: `http://127.0.0.1:${port}`,
          },
          body: JSON.stringify({ seat: 'dev', agent: dangerous }),
        });
        expect(resAgent.status).toBe(400);
      }
    });

    it('swaps seat successfully, saves setting and logs to console', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const res = await fetch(`${baseUrl}/api/seat`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ seat: 'dev', agent: 'jenny' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ ok: true, seat: 'dev', agent: 'jenny' });
      expect(store.getSetting('seat:dev')).toBe('jenny');
      expect(logSpy).toHaveBeenCalledWith('dev seat: jacky → jenny');
      logSpy.mockRestore();
    });
  });

  describe('Task 10a & 10b: Team Note & Note Image', () => {
    let testRepo: string;

    beforeEach(() => {
      testRepo = tmpRepo({
        'README.md': '# Project\n',
      });
      store.setActiveProject(testRepo);
    });

    it('POST /api/notes/delete: xoá DB + file trên main, ghim main mới; bận → 409; id project khác bỏ qua', async () => {
      const del = (body: unknown) => fetch(`${baseUrl}/api/notes/delete`, {
        method: 'POST',
        headers: { 'x-btm': '1', 'content-type': 'application/json', Origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });
      const gx = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: testRepo, encoding: 'utf8' }).trim();
      const a = store.createNote(testRepo, 'a', 'N-1.png');
      const b = store.createNote(testRepo, 'b', null);
      const other = store.createNote('/other', 'x', null);
      mkdirSync(join(testRepo, 'team', 'inbox'), { recursive: true });
      writeFileSync(join(testRepo, 'team', 'inbox', `N-${a}.md`), 'a');
      writeFileSync(join(testRepo, 'team', 'inbox', 'N-1.png'), 'p');
      writeFileSync(join(testRepo, 'team', 'inbox', `N-${b}.md`), 'b');
      gx('add', '-A');
      gx('commit', '-qm', 'inbox');
      expect((await del({})).status).toBe(400);
      host.busy = vi.fn().mockReturnValue(true);
      expect((await del({ all: true })).status).toBe(409);
      host.busy = vi.fn().mockReturnValue(false);
      const r = await del({ ids: [a, other] });
      expect(r.status).toBe(200);
      expect((await r.json()).deleted).toEqual([a]);
      expect(store.getNote(a)).toBeNull();
      expect(store.getNote(other)).not.toBeNull();
      expect(gx('ls-tree', '-r', '--name-only', 'main', 'team/inbox')).toBe(`team/inbox/N-${b}.md`);
      expect(store.getSetting(`protected_sha:${testRepo}`)).toBe(gx('rev-parse', 'main'));
      // N-b đang mở của phiên needs_owner → giữ lại; ghi chú cancelled vẫn xoá được
      const sid = store.createSession(['x'], testRepo);
      store.setSessionStatus(sid, 'needs_owner');
      store.setNoteSession(b, sid);
      const c = store.createNote(testRepo, 'c', null);
      store.setNoteStatus(c, 'cancelled');
      const r2 = await (await del({ all: true })).json();
      expect([r2.deleted, r2.skipped]).toEqual([[c], [b]]);
      expect((await del({ ids: [b] })).status).toBe(409);
      store.setSessionStatus(sid, 'done');
      expect((await del({ all: true })).status).toBe(200);
      expect(store.listNotes(testRepo)).toHaveLength(0);
      expect((await del({ all: true })).status).toBe(404);
    });

    it('rejects POST /api/team-note missing x-btm or invalid Origin', async () => {
      const res1 = await fetch(`${baseUrl}/api/team-note`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'Hello' }),
      });
      expect(res1.status).toBe(403);

      const res2 = await fetch(`${baseUrl}/api/team-note`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: 'https://evil.example.com',
        },
        body: JSON.stringify({ text: 'Hello' }),
      });
      expect(res2.status).toBe(403);
    });

    it('accepts valid PNG image: creates note in DB, does not write file directly, and calls host.start with goal containing N-id and note opts', async () => {
      // Fake PNG magic bytes 89 50 4E 47 followed by some dummy bytes
      const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
      const base64 = pngBuf.toString('base64');

      const res = await fetch(`${baseUrl}/api/team-note`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({
          text: 'Vui lòng kiểm tra lỗi giao diện theo ảnh',
          image: {
            name: 'screenshot.png',
            base64,
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.id).toBe(1);

      // Verify files in repo are NOT written yet (runSession will write them on session branch)
      const mdPath = join(testRepo, 'team', 'inbox', 'N-1.md');
      const imgPath = join(testRepo, 'team', 'inbox', 'N-1.png');
      expect(existsSync(mdPath)).toBe(false);
      expect(existsSync(imgPath)).toBe(false);

      // Verify host.start called
      expect(host.startCalls.length).toBe(1);
      expect(host.startCalls[0][0]).toContain('Team note N-1: Vui lòng kiểm tra lỗi');
      expect(host.startOpts[0]?.noteId).toBe(1);
      expect(host.startOpts[0]?.text).toBe('Vui lòng kiểm tra lỗi giao diện theo ảnh');
      expect(host.startOpts[0]?.image?.ext).toBe('png');
      expect(host.startOpts[0]?.image?.bytes).toEqual(pngBuf);

      // Simulate runSession placing the image on disk, and verify GET /api/notes/1/image serves it
      const inboxDir = join(testRepo, 'team', 'inbox');
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(imgPath, pngBuf);

      const getImgRes = await fetch(`${baseUrl}/api/notes/1/image`);
      expect(getImgRes.status).toBe(200);
      expect(getImgRes.headers.get('content-type')).toBe('image/png');
      const getImgBuf = Buffer.from(await getImgRes.arrayBuffer());
      expect(getImgBuf).toEqual(pngBuf);

      // GET /api/notes/N-1/image also works
      const getN1Res = await fetch(`${baseUrl}/api/notes/N-1/image`);
      expect(getN1Res.status).toBe(200);
      expect(getN1Res.headers.get('content-type')).toBe('image/png');
    });

    it('returns 415 when image has .png name but text content', async () => {
      const textBase64 = Buffer.from('this is not a valid image').toString('base64');
      const res = await fetch(`${baseUrl}/api/team-note`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({
          text: 'Note with fake png',
          image: {
            name: 'fake.png',
            base64: textBase64,
          },
        }),
      });

      expect(res.status).toBe(415);
    });

    it('returns 413 when image exceeds 5 MB limit', async () => {
      // 6 MB of dummy bytes
      const bigBuf = Buffer.alloc(6 * 1024 * 1024);
      bigBuf[0] = 0x89;
      bigBuf[1] = 0x50;
      bigBuf[2] = 0x4e;
      bigBuf[3] = 0x47;
      const bigBase64 = bigBuf.toString('base64');

      const res = await fetch(`${baseUrl}/api/team-note`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({
          text: 'Note with 6MB image',
          image: {
            name: 'huge.png',
            base64: bigBase64,
          },
        }),
      });

      expect(res.status).toBe(413);
    });

    it('rejects POST /api/team-note when team/inbox is a symlink pointing outside project', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'btm-outside-'));
      mkdirSync(join(testRepo, 'team'), { recursive: true });
      symlinkSync(outsideDir, join(testRepo, 'team', 'inbox'));

      try {
        const res = await fetch(`${baseUrl}/api/team-note`, {
          method: 'POST',
          headers: {
            'x-btm': '1',
            'content-type': 'application/json',
            Origin: `http://127.0.0.1:${port}`,
          },
          body: JSON.stringify({
            text: 'Symlink outside test',
          }),
        });

        expect(res.status).toBe(400);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('deletes DB note and returns error when host.start fails', async () => {
      host.start = async () => ({ ok: false, error: 'Failed to start session' });

      const res = await fetch(`${baseUrl}/api/team-note`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({
          text: 'Pre-existing file collision test',
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('Failed to start session');
      expect(store.listNotes(testRepo).length).toBe(0);
    });

    it('returns 409 "Session running" when host is busy, without writing file or committing note', async () => {
      host.busy = () => true;

      const res = await fetch(`${baseUrl}/api/team-note`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({
          text: 'Note while host is busy',
        }),
      });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe('Session running');

      // Verify no note in DB
      const notes = store.listNotes(testRepo);
      expect(notes.length).toBe(0);

      // Verify no file written
      const inboxDir = join(testRepo, 'team', 'inbox');
      expect(existsSync(join(inboxDir, 'N-1.md'))).toBe(false);
    });

    it('returns 404 for GET /api/notes/<id>/image when note does not exist or has no image', async () => {
      const res1 = await fetch(`${baseUrl}/api/notes/999/image`);
      expect(res1.status).toBe(404);

      // Create note without image
      const noteNoImg = store.createNote(testRepo, 'Note without image');
      const res2 = await fetch(`${baseUrl}/api/notes/${noteNoImg}/image`);
      expect(res2.status).toBe(404);
    });

    it('returns 404 for GET /api/notes/<id>/image when image is a symlink or has mismatched magic bytes', async () => {
      const noteId = store.createNote(testRepo, 'Note with symlink image');
      store.setNoteImage(noteId, `N-${noteId}.png`);
      const inboxDir = join(testRepo, 'team', 'inbox');
      mkdirSync(inboxDir, { recursive: true });

      // 1. Symlink image
      const outsideFile = join(tmpdir(), `btm-symlink-target-${Date.now()}.png`);
      const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      writeFileSync(outsideFile, validPng);
      symlinkSync(outsideFile, join(inboxDir, `N-${noteId}.png`));

      try {
        const symlinkRes = await fetch(`${baseUrl}/api/notes/${noteId}/image`);
        expect(symlinkRes.status).toBe(404);
      } finally {
        rmSync(join(inboxDir, `N-${noteId}.png`), { force: true });
        rmSync(outsideFile, { force: true });
      }

      // 2. Corrupt / mismatched magic bytes
      writeFileSync(join(inboxDir, `N-${noteId}.png`), Buffer.from('not a real png header'));
      try {
        const corruptRes = await fetch(`${baseUrl}/api/notes/${noteId}/image`);
        expect(corruptRes.status).toBe(404);
      } finally {
        rmSync(join(inboxDir, `N-${noteId}.png`), { force: true });
      }
    });

    it('always saves JPEG with .jpg extension even if upload name ends with .jpeg', async () => {
      const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const res = await fetch(`${baseUrl}/api/team-note`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({
          text: 'Note with jpeg photo',
          image: {
            name: 'photo.jpeg',
            base64: jpegBuf.toString('base64'),
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      const noteId = data.id;

      const note = store.getNote(noteId);
      expect(note?.image).toBe(`N-${noteId}.jpg`);
      expect(host.startOpts[0]?.image?.ext).toBe('jpg');

      const inboxDir = join(testRepo, 'team', 'inbox');
      mkdirSync(inboxDir, { recursive: true });
      const jpgPath = join(inboxDir, `N-${noteId}.jpg`);
      writeFileSync(jpgPath, jpegBuf);

      const getRes = await fetch(`${baseUrl}/api/notes/${noteId}/image`);
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get('content-type')).toBe('image/jpeg');
    });

    it('rejects PNG image when it has only 4 magic bytes instead of 8 bytes', async () => {
      const fourBytePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const res = await fetch(`${baseUrl}/api/team-note`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({
          text: 'Note with truncated png header',
          image: {
            name: 'short.png',
            base64: fourBytePng.toString('base64'),
          },
        }),
      });

      expect(res.status).toBe(415);
    });

    it('deletes DB note and returns 400 when host.start throws', async () => {
      host.start = async () => {
        throw new Error('Host start crashed');
      };

      const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      const res = await fetch(`${baseUrl}/api/team-note`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({
          text: 'Note that fails to start',
          image: {
            name: 'test.png',
            base64: pngBuf.toString('base64'),
          },
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Host start crashed');

      // Verify DB note was deleted
      expect(store.listNotes(testRepo).length).toBe(0);
    });

    it('returns 409 when host.start reports session already running', async () => {
      host.start = async () => ({ ok: false, error: 'Session running' });

      const res = await fetch(`${baseUrl}/api/team-note`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({
          text: 'Note when session running',
        }),
      });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe('Session running');
      expect(store.listNotes(testRepo).length).toBe(0);
    });
  });

  describe('P4-T9: GET /api/tickets/:id/history', () => {
    it('returns 404 when there is no active project', async () => {
      const res = await fetch(`${baseUrl}/api/tickets/GTM-0001/history`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('No active project');
    });

    it('returns chronological ticket history when project is active', async () => {
      const projDir = '/repo/test-proj';
      store.setActiveProject(projDir);
      store.upsertTicket(projDir, {
        id: 'GTM-0001',
        goal: 'G1',
        number: 1,
        of: 1,
        title: 'Ticket Test',
        type: 'feat',
        size: 'S',
        scope: ['src/'],
        acceptance: ['ok'],
        done_when: 'done',
        depends_on: [],
        from_audit: false,
      });

      store.setTicketState(projDir, 'GTM-0001', 'in_dev', 'jacky', 'started work');
      store.setTicketState(projDir, 'GTM-0001', 'awaiting_qc', 'jacky', 'dev done');
      store.setTicketState(projDir, 'GTM-0001', 'passed', 'jenny', 'qc ok');

      const res = await fetch(`${baseUrl}/api/tickets/GTM-0001/history`);
      expect(res.status).toBe(200);
      const history = await res.json();
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThanOrEqual(3);
      expect(history[0].to_state).toBe('in_dev');
      expect(history[0].by).toBe('jacky');
      expect(history[1].to_state).toBe('awaiting_qc');
      expect(history[2].to_state).toBe('passed');
      expect(history[2].by).toBe('jenny');
    });
  });

  it('Plan 9 Task 2: GET /api/system trả JSON đủ khoá', async () => {
    const res = await fetch(`${baseUrl}/api/system`);
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const k of ['cpuPercent', 'ramPercent', 'diskPercent', 'netInBps', 'netOutBps', 'healthy']) expect(body).toHaveProperty(k);
  });

  describe('POST /api/goal/push (decision 0006)', () => {
    const post = (body: unknown) => fetch(`${baseUrl}/api/goal/push`, {
      method: 'POST',
      headers: { 'x-btm': '1', 'content-type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify(body),
    });
    it('400 khi goal sai dạng, 501 khi host không hỗ trợ', async () => {
      expect((await post({ goal: 'x' })).status).toBe(400);
      expect((await post({ goal: 'G1' })).status).toBe(501);
    });
    it('gọi host.retryRelease: ok → 200, lỗi → 502, chưa cấu hình → 409', async () => {
      const seen: number[] = [];
      let next: unknown = { goal: 1, tag: 'v1.0.0', target: 'a/b', url: 'https://github.com/a/b/tree/v1.0.0', ok: true, at: 'now' };
      (host as any).retryRelease = async (n: number) => { seen.push(n); return next; };
      expect((await post({ goal: 'G1' })).status).toBe(200);
      next = { goal: 1, tag: 'v1.0.0', target: 'a/b', url: '', ok: false, error: 'push_timeout', at: 'now' };
      expect((await post({ goal: 'G1' })).status).toBe(502);
      next = null;
      expect((await post({ goal: 'G1' })).status).toBe(409);
      expect(seen).toEqual([1, 1, 1]);
    });
  });

  describe('P4-T9: POST /api/goal/approve', () => {
    it('returns 403 when x-btm header is missing', async () => {
      const res = await fetch(`${baseUrl}/api/goal/approve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goal: 'G1' }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 403 when Origin is invalid', async () => {
      const res = await fetch(`${baseUrl}/api/goal/approve`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: 'http://malicious-site.com',
        },
        body: JSON.stringify({ goal: 'G1' }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 415 when Content-Type is not application/json', async () => {
      const res = await fetch(`${baseUrl}/api/goal/approve`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'text/plain',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: 'goal=G1',
      });
      expect(res.status).toBe(415);
    });

    it('returns 400 when body does not match schema { goal: "G<n>" }', async () => {
      const res = await fetch(`${baseUrl}/api/goal/approve`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goal: 'invalid-goal' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Invalid goal format');
    });

    it('returns 409 when host.busy() returns true', async () => {
      host.busy = () => true;
      const res = await fetch(`${baseUrl}/api/goal/approve`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goal: 'G1' }),
      });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.code).toBe('busy');
    });

    it('returns 409 when goal is not_ready or conflict', async () => {
      host.busy = () => false;
      host.approveGoal = () => ({
        ok: false,
        code: 'not_ready',
        message: 'Goal G1 is in state in_progress, expected qc_done',
      });

      const res = await fetch(`${baseUrl}/api/goal/approve`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goal: 'G1' }),
      });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.code).toBe('not_ready');
      expect(data.message).toContain('qc_done');
    });

    it('returns 200 and calls host.approveGoal on success', async () => {
      host.busy = () => false;
      host.approveGoal = (n: number) => {
        host.approveGoalCalls.push(n);
        return { ok: true, sha: 'abcd1234ef5678' };
      };

      const res = await fetch(`${baseUrl}/api/goal/approve`, {
        method: 'POST',
        headers: {
          'x-btm': '1',
          'content-type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ goal: 'G2' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.sha).toBe('abcd1234ef5678');
      expect(host.approveGoalCalls).toContain(2);
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

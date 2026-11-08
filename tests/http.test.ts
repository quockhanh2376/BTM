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
    stopCalls: number;
    commandCalls: { to: string; text: string }[];
    autoApproveCalls: boolean[];
  };

  beforeEach(async () => {
    store = openStore(':memory:');
    cfg = loadConfig('btm.config.yaml');
    webFile = resolve(__dirname, '../web/index.html');

    host = {
      startCalls: [],
      startOpts: [],
      approveCalls: 0,
      stopCalls: 0,
      commandCalls: [],
      autoApproveCalls: [],
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

  describe('Task 10a & 10b: Team Note & Note Image', () => {
    let testRepo: string;

    beforeEach(() => {
      testRepo = tmpRepo({
        'README.md': '# Project\n',
      });
      store.setActiveProject(testRepo);
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
      expect(host.startCalls[0][0]).toContain('Xử lý ghi chú team N-1: Vui lòng kiểm tra lỗi');
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

    it('returns 409 "Đang có phiên chạy" when host is busy, without writing file or committing note', async () => {
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
      expect(data.error).toBe('Đang có phiên chạy');

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
      host.start = async () => ({ ok: false, error: 'Đang có phiên chạy' });

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
      expect(data.error).toBe('Đang có phiên chạy');
      expect(store.listNotes(testRepo).length).toBe(0);
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

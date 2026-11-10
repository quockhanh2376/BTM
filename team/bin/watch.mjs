#!/usr/bin/env node
// Xem trực tiếp V/Q đang làm gì: theo dõi file team/runs/*.stream.jsonl mới nhất, in từng bước dạng dễ đọc.
// Dùng: node team/bin/watch.mjs   (Ctrl-C để thoát). Chỉ đọc, không gửi gì cho agent.
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';

const dir = join(import.meta.dirname, '..', 'runs');
let file = null, pos = 0, buf = '', text = '';

const latest = () => readdirSync(dir).filter((f) => f.endsWith('.stream.jsonl'))
  .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.f ?? null;
const hhmm = () => new Date().toTimeString().slice(0, 8);
const short = (s, n = 110) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const rel = (p) => String(p ?? '').replace(/^.*?BotTaskManager[\\/]/i, '');

function describe(u) {
  if (u.step_type === 'tool') {
    const p = u.tool_info?.parameters ?? {};
    const target = p.CommandLine ?? p.Path ?? p.AbsolutePath ?? p.TargetFile ?? p.SearchPath ?? p.Query ?? p.SearchDirectory ?? '';
    const out = u.state === 'DONE' && u.tool_info?.output ? `  → ${short(u.tool_info.output, 60)}` : '';
    return `${u.state === 'ACTIVE' ? '▶' : '✓'} ${u.tool_name}  ${short(rel(target), 90)}${out}`;
  }
  return null;
}

// Codex (`codex exec --json`): thread.started / item.started|completed / turn.completed|failed.
function handleCodex(j) {
  if (j.type === 'thread.started') { console.log(`\n=== ${hhmm()} BẮT ĐẦU (codex) ${basename(file)}`); return; }
  if (j.type === 'turn.completed' || j.type === 'turn.failed') {
    console.log(`=== ${hhmm()} KẾT THÚC · ${j.type === 'turn.completed' ? 'SUCCESS' : 'ERROR ' + short(j.error?.message, 200)}\n`);
    return;
  }
  const it = j.item; if (!it) return;
  const done = j.type === 'item.completed';
  if (it.type === 'agent_message' && done) console.log(`  💬 ${short(it.text, 300)}`);
  else if (it.type === 'command_execution') console.log(`${hhmm()}  ${done ? `✓ (exit ${it.exit_code})` : '▶'} ${short(it.command, 110)}`);
  else if (it.type === 'file_change' && done) console.log(`${hhmm()}  ✎ ${(it.changes ?? []).map((c) => `${c.kind} ${rel(c.path)}`).join(', ')}`);
  else if (it.type === 'error' && done) console.log(`${hhmm()}  ⚠ ${short(it.message, 150)}`);
}

function handle(line) {
  let j; try { j = JSON.parse(line); } catch { return; }
  if (j.type) return handleCodex(j);
  if (j.event === 'init') { console.log(`\n=== ${hhmm()} BẮT ĐẦU ${basename(file)}`); return; }
  if (j.event === 'result') {
    if (text.trim()) console.log(`  💬 ${short(text, 300)}`); text = '';
    const r = j.result ?? {};
    console.log(`=== ${hhmm()} KẾT THÚC · ${r.status} · ${Math.round(r.duration_seconds ?? 0)}s${r.denied_actions?.length ? ' · BỊ CHẶN: ' + JSON.stringify(r.denied_actions) : ''}\n`);
    return;
  }
  const u = j.step_update; if (!u) return;
  if (u.step_type === 'agent_response') {
    if (u.text_delta) text += u.text_delta;
    if (u.state === 'DONE' && text.trim()) { console.log(`  💬 ${short(text, 300)}`); text = ''; }
    return;
  }
  const d = describe(u); if (d) console.log(`${hhmm()}  ${d}`);
}

function tick() {
  const f = latest();
  if (f !== file) { file = f; pos = 0; buf = ''; text = ''; if (f) console.log(`--- theo dõi ${basename(f)}`); }
  if (!file) return;
  const size = statSync(file).size;
  if (size <= pos) return;
  const fd = openSync(file, 'r'); const b = Buffer.alloc(size - pos); readSync(fd, b, 0, b.length, pos); closeSync(fd);
  pos = size; buf += b.toString('utf8');
  const lines = buf.split('\n'); buf = lines.pop();
  for (const l of lines) handle(l);
}

console.log('Xem tiến trình V/Q (team/runs/*.stream.jsonl). Ctrl-C để thoát.');
setInterval(tick, 1000); tick();

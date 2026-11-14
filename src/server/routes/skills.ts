// Route nhóm "skills" tách khỏi http.ts 2026-11-14 (docs/engineering-rules.md). Không đổi hành vi.
// handle*(…) trả true khi đã trả lời request.
import type { ServerResponse } from 'node:http';
import type { ServerOpts, SendJson } from '../http.ts';
import { z } from 'zod';
import { readProjectKey } from '../../ticket/goal.ts';
import { agentNameKey } from '../../agents/names.ts';
import { projectSignals, readSkills, skillText } from '../../skills/lane.ts';
import { fitsProject } from '../../skills/core.ts';

export async function handleSkillsGet(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  // Skill cho agent (2026-11-14): thư viện + gợi ý cho project đang mở + ai kiểm bảo mật; xem toàn văn một skill.
  if (method === 'GET' && pathname === '/api/skills') {
    const project = o.store.getActiveProject();
    let key = '';
    try { key = project ? readProjectKey(project) : ''; } catch { key = ''; }
    const sig = project ? projectSignals(project) : { exts: [], hasUi: false, hasTests: false };
    const skills = readSkills(o.store);
    const nameOf = (agent: string) => o.store.getSetting(agentNameKey(agent)) || agent;
    sendJson(res, 200, {
      skills,
      project: { key, hasUi: sig.hasUi, hasTests: sig.hasTests, exts: sig.exts.slice(0, 30) },
      suggested: skills.filter((s) => fitsProject(s.name, s.description, sig)).map((s) => s.id),
      reviewers: (o.host.skills?.reviewers() ?? []).map(nameOf),
    });
    return true;
  }
  const skillTextMatch = method === 'GET' ? pathname.match(/^\/api\/skills\/(\d{1,6})\/text$/) : null;
  if (skillTextMatch) {
    const id = parseInt(skillTextMatch[1]!, 10);
    const text = readSkills(o.store).some((s) => s.id === id) ? skillText(o.cfg.host.data_dir, id) : '';
    if (!text) {
      sendJson(res, 404, { error: 'Unknown skill' });
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(text);
    return true;
  }
  return false;
}

export async function handleSkillsPost(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  // Skill cho agent (2026-11-14): dán / liệt kê + nhập từ GitHub / chỉnh ghế + project + bật tắt / kiểm lại / xoá.
  if (pathname === '/api/skills') {
    const seat = z.enum(['pm', 'dev', 'qc', 'audit']);
    const parsed = z.discriminatedUnion('action', [
      z.object({ action: z.literal('paste'), text: z.string().min(1).max(20000) }),
      z.object({ action: z.literal('github-list'), url: z.string().min(1).max(300) }),
      z.object({ action: z.literal('search'), query: z.string().min(1).max(200) }),
      z.object({ action: z.literal('search-import'), items: z.array(z.object({ source: z.string().max(150), skillId: z.string().max(90) })).min(1).max(20) }),
      z.object({ action: z.literal('github-import'), url: z.string().min(1).max(300), paths: z.array(z.string().max(300)).min(1).max(30) }),
      z.object({ action: z.literal('update'), id: z.number().int().positive(), seats: z.array(seat).max(4).optional(), projects: z.union([z.literal('all'), z.array(z.string().max(20)).max(50)]).optional(), on: z.boolean().optional() }),
      z.object({ action: z.literal('recheck'), id: z.number().int().positive() }),
      z.object({ action: z.literal('delete'), id: z.number().int().positive() }),
    ]).safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid skills request' });
      return true;
    }
    const lane = o.host.skills;
    if (!lane) {
      sendJson(res, 501, { error: 'Skills not available' });
      return true;
    }
    const p = parsed.data;
    const r = p.action === 'paste' ? lane.add(p.text, 'pasted')
      : p.action === 'github-list' ? await lane.listGithub(p.url)
      : p.action === 'search' ? await lane.search(p.query)
      : p.action === 'search-import' ? await lane.importFound(p.items)
      : p.action === 'github-import' ? await lane.importGithub(p.url, p.paths)
      : p.action === 'update' ? lane.update(p.id, { seats: p.seats, projects: p.projects, on: p.on })
      : p.action === 'recheck' ? lane.recheck(p.id)
      : { ok: true as const, skills: lane.remove(p.id) };
    sendJson(res, r.ok ? 200 : r.status, r.ok ? r : { error: r.error });
    return true;
  }
  return false;
}

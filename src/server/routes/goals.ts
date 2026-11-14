// Route nhóm "goals" tách khỏi http.ts 2026-11-14 (docs/engineering-rules.md). Không đổi hành vi.
// handle*(…) trả true khi đã trả lời request.
import type { ServerResponse } from 'node:http';
import type { ServerOpts, SendJson } from '../http.ts';
import { z } from 'zod';
import { approveGoal, readProjectKey, type ApproveGoalResult } from '../../ticket/goal.ts';
import { projectLessonsFile, readLessons, sharedLessonsFile, writeLessons, LESSONS_EDIT_MAX } from '../../knowledge/lessons.ts';
import { archiveGoalAction, restoreGoalAction, purgeGoalAction } from '../goal-trash.ts';
import { buildGoalDigest, saveGoalDigest } from '../../knowledge/digest.ts';
import { saveProjectMap, buildProjectMap } from '../../knowledge/map.ts';
import { readMeetings, readStagedDocs } from '../../meeting/lane.ts';
import { renderMeetingHtml, renderMeetingMd } from '../../meeting/core.ts';
import { agentNameKey } from '../../agents/names.ts';
import { projectSignals, readSkills, skillText } from '../../skills/lane.ts';
import { fitsProject } from '../../skills/core.ts';
import { readStandards, readUiDefaults, StandardsSchema, UiDefaultsSchema, STANDARDS_KEY, UI_DEFAULTS_KEY, TIMEZONES } from '../../standards.ts';
import { readFileSync } from 'node:fs';

export async function handleGoalsGet(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  // Bài học (2026-11-14): file của project + file chung.
  if (method === 'GET' && pathname === '/api/lessons') {
    const project = o.store.getActiveProject();
    if (!project) {
      sendJson(res, 404, { error: 'No active project' });
      return true;
    }
    sendJson(res, 200, {
      project: readLessons(projectLessonsFile(o.cfg.host.data_dir, project) ?? ''),
      shared: readLessons(sharedLessonsFile(o.cfg.host.data_dir)),
    });
    return true;
  }

  // Thùng rác goal: danh sách goal đã vào thùng rác.
  if (method === 'GET' && pathname === '/api/goals/trash') {
    const project = o.store.getActiveProject();
    const rows = project ? o.store.listArchivedGoals(project) : [];
    sendJson(res, 200, rows.map((g) => ({
      n: g.n, title: g.title, state: g.state, archivedAt: g.archived_at,
      tickets: project ? o.store.listTickets(project, `G${g.n}`).length : 0,
    })));
    return true;
  }

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

  // Settings (2026-11-14): chuẩn cho mọi project + mặc định dashboard.
  if (method === 'GET' && pathname === '/api/standards') {
    sendJson(res, 200, { standards: readStandards(o.store), ui: readUiDefaults(o.store), timezones: TIMEZONES });
    return true;
  }

  // Họp (2026-11-14): tài liệu đang chờ; danh sách cuộc họp; xuất biên bản (md / html – html in ra PDF hoặc mở bằng Word).
  if (method === 'GET' && pathname === '/api/meeting/docs') {
    const project = o.store.getActiveProject();
    sendJson(res, 200, { docs: project ? readStagedDocs(o.store, project) : [] });
    return true;
  }
  if (method === 'GET' && pathname === '/api/meetings') {
    const project = o.store.getActiveProject();
    sendJson(res, 200, { meetings: (project ? readMeetings(o.store, project) : []).map((m) => ({ id: m.id, topic: m.topic.slice(0, 200), status: m.status, createdAt: m.createdAt })) });
    return true;
  }
  const exportMatch = method === 'GET' ? pathname.match(/^\/api\/meetings\/(\d{1,6})\/export\.(md|html)$/) : null;
  if (exportMatch) {
    const project = o.store.getActiveProject();
    const m = project ? readMeetings(o.store, project).find((x) => x.id === parseInt(exportMatch[1]!, 10)) : null;
    if (!m) {
      sendJson(res, 404, { error: 'Unknown meeting' });
      return true;
    }
    const nameOf = (agent: string) => o.store.getSetting(agentNameKey(agent)) || agent;
    const html = exportMatch[2] === 'html';
    res.writeHead(200, {
      'Content-Type': html ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="meeting-M${m.id}.${exportMatch[2]}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // Biên bản chứa chữ của agent: file HTML tải về không được chạy script hay tải gì từ ngoài.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(html ? renderMeetingHtml(m, nameOf) : renderMeetingMd(m, nameOf));
    return true;
  }

  // Bản đồ project (2026-11-14): dựng lại từ code lúc mở, lưu bản mới nhất; chữ thường.
  if (method === 'GET' && pathname === '/api/project/map') {
    const project = o.store.getActiveProject();
    const file = project ? saveProjectMap(o.store, o.cfg, project) : null;
    let text = '';
    try { text = file ? readFileSync(file, 'utf8') : (project ? buildProjectMap(o.store, project) : ''); } catch { text = ''; }
    if (!text) {
      sendJson(res, 404, { error: 'No project map' });
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(text);
    return true;
  }

  // Kho kiến thức: nhật ký nén của một goal (chữ thường, để anh xem; giống bản đưa vào câu hỏi).
  const kbMatch = method === 'GET' ? pathname.match(/^\/api\/goals\/(\d{1,6})\/knowledge$/) : null;
  if (kbMatch) {
    const project = o.store.getActiveProject();
    const text = project ? buildGoalDigest(o.store, o.cfg, project, parseInt(kbMatch[1]!, 10)) : null;
    if (!text) {
      sendJson(res, 404, { error: 'Unknown goal' });
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(text);
    return true;
  }
  return false;
}

export async function handleGoalsPost(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  // Settings (2026-11-14): lưu chuẩn cho mọi project + mặc định dashboard (cả hai, hoặc một trong hai).
  if (pathname === '/api/standards') {
    const parsed = z.object({ standards: StandardsSchema.optional(), ui: UiDefaultsSchema.optional() }).safeParse(body);
    if (!parsed.success || (!parsed.data.standards && !parsed.data.ui)) {
      sendJson(res, 400, { error: 'Invalid settings' });
      return true;
    }
    if (parsed.data.standards) o.store.setSetting(STANDARDS_KEY, JSON.stringify(parsed.data.standards));
    if (parsed.data.ui) o.store.setSetting(UI_DEFAULTS_KEY, JSON.stringify(parsed.data.ui));
    sendJson(res, 200, { ok: true, standards: readStandards(o.store), ui: readUiDefaults(o.store) });
    return true;
  }

  // Anh Zon sửa bài học (2026-11-14).
  if (pathname === '/api/lessons') {
    const parsed = z.object({ scope: z.enum(['project', 'shared']), text: z.string().max(LESSONS_EDIT_MAX) }).safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid lessons' });
      return true;
    }
    const project = o.store.getActiveProject();
    if (!project) {
      sendJson(res, 404, { error: 'No active project' });
      return true;
    }
    const file = parsed.data.scope === 'shared' ? sharedLessonsFile(o.cfg.host.data_dir) : projectLessonsFile(o.cfg.host.data_dir, project);
    if (!file) {
      sendJson(res, 400, { error: 'Project has no key (team/project.yaml)' });
      return true;
    }
    writeLessons(file, parsed.data.text.replace(/\r\n/g, '\n'));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/goal/approve') {
    const GoalApproveSchema = z.object({
      goal: z.string().regex(/^G?(\d+)$/i, { message: 'Invalid goal format, expected G<n>' }),
    });
    const parsed = GoalApproveSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
      return true;
    }
    if (o.host.busy?.()) {
      sendJson(res, 409, { ok: false, code: 'busy', error: 'Session running', message: 'Session running' });
      return true;
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
        return true;
      }
      resGoal = approveGoal(o.store, activeProject, o.cfg, goalNumber);
    }
    if (resGoal.ok) {
      sendJson(res, 200, resGoal);
    } else {
      sendJson(res, 409, { ok: false, code: resGoal.code, message: resGoal.message, error: resGoal.message });
    }
    return true;
  }

  // Decision 0006: Push lại main + tag lên GitHub khi lần push sau Approve bị lỗi.
  if (pathname === '/api/goal/push') {
    const parsed = z.object({ goal: z.string().regex(/^G?(\d+)$/i) }).strict().safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid goal format, expected G<n>' });
      return true;
    }
    if (o.host.busy?.()) {
      sendJson(res, 409, { error: 'Session running' });
      return true;
    }
    if (!o.host.retryRelease) {
      sendJson(res, 501, { error: 'Not implemented' });
      return true;
    }
    const info = await o.host.retryRelease(parseInt(parsed.data.goal.replace(/^G/i, ''), 10));
    if (!info) {
      sendJson(res, 409, { error: 'No GitHub release configured for this project' });
      return true;
    }
    sendJson(res, info.ok ? 200 : 502, info);
    return true;
  }
  // Thùng rác goal: vào thùng rác / khôi phục / xoá hẳn (có sao lưu). Không cho khi có phiên chạy.
  const trashMatch = pathname.match(/^\/api\/goals\/(\d{1,6})\/(archive|restore|purge)$/);
  if (trashMatch) {
    if (o.host.busy?.()) {
      sendJson(res, 409, { error: 'Session running' });
      return true;
    }
    const project = o.store.getActiveProject();
    if (!project) {
      sendJson(res, 400, { error: 'No active project' });
      return true;
    }
    const n = parseInt(trashMatch[1]!, 10);
    let result;
    try {
      if (trashMatch[2] === 'archive') saveGoalDigest(o.store, o.cfg, project, n); // lưu nhật ký trước khi ẩn
      result = trashMatch[2] === 'archive' ? archiveGoalAction(o.store, project, n)
        : trashMatch[2] === 'restore' ? restoreGoalAction(o.store, project, n)
        : purgeGoalAction(o.store, o.cfg, project, n);
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message || 'Trash action failed' });
      return true;
    }
    sendJson(res, result.ok ? 200 : result.status, result);
    return true;
  }
  return false;
}

// Route nhóm "goals" tách khỏi http.ts 2026-11-14 (docs/engineering-rules.md). Không đổi hành vi.
// handle*(…) trả true khi đã trả lời request.
import type { ServerResponse } from 'node:http';
import type { ServerOpts, SendJson } from '../http.ts';
import { z } from 'zod';
import { approveGoal, type ApproveGoalResult } from '../../ticket/goal.ts';
import { projectLessonsFile, readLessons, sharedLessonsFile, writeLessons, LESSONS_EDIT_MAX } from '../../knowledge/lessons.ts';
import { archiveGoalAction, restoreGoalAction, purgeGoalAction } from '../goal-trash.ts';
import { buildGoalDigest, saveGoalDigest } from '../../knowledge/digest.ts';
import { saveProjectMap, buildProjectMap } from '../../knowledge/map.ts';
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

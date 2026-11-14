// Route nhóm "meeting" tách khỏi http.ts 2026-11-14 (docs/engineering-rules.md). Không đổi hành vi.
// handle*(…) trả true khi đã trả lời request.
import { renderMeetingDocx } from '../../meeting/docx.ts';
import type { ServerResponse } from 'node:http';
import type { ServerOpts, SendJson } from '../http.ts';
import { z } from 'zod';
import { readMeetings, readStagedDocs, roomClearedKey } from '../../meeting/lane.ts';
import { renderMeetingHtml, renderMeetingMd } from '../../meeting/core.ts';
import { agentNameKey } from '../../agents/names.ts';

export async function handleMeetingGet(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
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
  const exportMatch = method === 'GET' ? pathname.match(/^\/api\/meetings\/(\d{1,6})\/export\.(md|html|docx)$/) : null;
  if (exportMatch) {
    const project = o.store.getActiveProject();
    const m = project ? readMeetings(o.store, project).find((x) => x.id === parseInt(exportMatch[1]!, 10)) : null;
    if (!m) {
      sendJson(res, 404, { error: 'Unknown meeting' });
      return true;
    }
    const nameOf = (agent: string) => o.store.getSetting(agentNameKey(agent)) || agent;
    if (exportMatch[2] === 'docx') {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="meeting-M${m.id}.docx"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(renderMeetingDocx(m, nameOf));
      return true;
    }
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
  return false;
}

export async function handleMeetingPost(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  // Dọn Meeting room (anh Zon 2026-11-14): ẩn mọi tin trước lúc này; "show" bỏ mốc để hiện lại.
  if (pathname === '/api/meeting-room') {
    const parsed = z.object({ action: z.enum(['clear', 'show']) }).safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid request' });
      return true;
    }
    const project = o.store.getActiveProject();
    if (!project) {
      sendJson(res, 400, { error: 'No active project' });
      return true;
    }
    const at = parsed.data.action === 'clear' ? new Date().toISOString() : '';
    o.store.setSetting(roomClearedKey(project), at);
    sendJson(res, 200, { ok: true, roomClearedAt: at });
    return true;
  }
  // Tài liệu cho cuộc họp sắp mở (2026-11-14): upload từng file (base64), Core rút chữ; hoặc bỏ một file.
  if (pathname === '/api/meeting/doc') {
    const parsed = z.union([
      z.object({ action: z.literal('add'), name: z.string().min(1).max(200), base64: z.string().min(1) }),
      z.object({ action: z.literal('remove'), id: z.number().int().positive() }),
    ]).safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid document request' });
      return true;
    }
    if (!o.host.meetingDocs) {
      sendJson(res, 501, { error: 'Meetings not available' });
      return true;
    }
    if (parsed.data.action === 'remove') {
      sendJson(res, 200, { ok: true, docs: o.host.meetingDocs.remove(parsed.data.id) });
      return true;
    }
    const r = await o.host.meetingDocs.add(parsed.data.name, Buffer.from(parsed.data.base64, 'base64'));
    sendJson(res, r.ok ? 200 : r.status, r.ok ? { ok: true, doc: r.doc, docs: o.host.meetingDocs.list() } : { error: r.error });
    return true;
  }

  // Họp tranh luận (2026-11-14): mở / dừng / tiếp tục (kèm ghi chú) / kết luận luôn / đóng.
  if (pathname === '/api/meeting') {
    const parsed = z.object({
      action: z.enum(['start', 'stop', 'resume', 'conclude', 'close']),
      topic: z.string().trim().max(4000).optional(),
      quick: z.boolean().optional(),
      note: z.string().max(1000).optional(),
    }).safeParse(body);
    if (!parsed.success || (parsed.data.action === 'start' && !parsed.data.topic)) {
      sendJson(res, 400, { error: 'Invalid meeting request' });
      return true;
    }
    if (!o.host.meeting) {
      sendJson(res, 501, { error: 'Meetings not available' });
      return true;
    }
    const r = await o.host.meeting(parsed.data.action, parsed.data);
    sendJson(res, r.ok ? 200 : r.status, r.ok ? r : { error: r.error });
    return true;
  }
  return false;
}

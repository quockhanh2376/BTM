// Route nhóm "notes/inbox" tách khỏi http.ts 2026-11-14 (docs/engineering-rules.md). Không đổi hành vi.
// handle*(…) trả true khi đã trả lời request.
import type { ServerResponse } from 'node:http';
import type { ServerOpts, SendJson } from '../http.ts';
import { z } from 'zod';
import { inboxPath, detectImage, readInboxFile, removeInboxFromMain } from '../inbox.ts';
import { protectedShaKey } from '../../core/guard.ts';

export async function handleNotesGet(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  // Note image route
  const noteImageMatch = pathname.match(/^\/api\/notes\/([^/]+)\/image$/);
  if (method === 'GET' && noteImageMatch) {
    const rawId = noteImageMatch[1];
    const noteId = Number(rawId.replace(/^N-/, ''));
    if (isNaN(noteId)) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }
    const activeProject = o.store.getActiveProject();
    if (!activeProject) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }
    const note = o.store.getNote(noteId);
    if (!note || note.project !== activeProject || !note.image) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }

    const validNameRegex = new RegExp(`^(N-)?${noteId}\\.(png|jpg|webp)$`);
    if (!validNameRegex.test(note.image)) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }

    const imgBuf = readInboxFile(activeProject, note.image);
    if (!imgBuf) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }

    const detected = detectImage(imgBuf);
    if (!detected) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }

    if (!note.image.endsWith(`.${detected.ext}`)) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }

    res.writeHead(200, {
      'Content-Type': detected.mime,
      'Content-Length': imgBuf.length,
    });
    res.end(imgBuf);
    return true;
  }
  return false;
}

export async function handleNotesPost(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
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
      return true;
    }

    const activeProject = o.store.getActiveProject();
    if (!activeProject) {
      sendJson(res, 400, { error: 'No active project' });
      return true;
    }

    if (o.host.busy && o.host.busy()) {
      sendJson(res, 409, { error: 'Session running' });
      return true;
    }

    let imgBuf: Buffer | null = null;
    let ext: 'png' | 'jpg' | 'webp' | null = null;

    if (parsed.data.image) {
      try {
        imgBuf = Buffer.from(parsed.data.image.base64, 'base64');
      } catch {
        sendJson(res, 400, { error: 'Invalid base64 image data' });
        return true;
      }

      if (imgBuf.length > 5 * 1024 * 1024) {
        sendJson(res, 413, { error: 'Image exceeds 5 MB limit' });
        return true;
      }

      const detected = detectImage(imgBuf);
      if (!detected) {
        sendJson(res, 415, { error: 'Unsupported image format' });
        return true;
      }
      ext = detected.ext;
    }

    try {
      inboxPath(activeProject, 'N-0');
    } catch (err: any) {
      sendJson(res, 400, { error: err?.message || 'team/inbox must be inside project' });
      return true;
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
      return true;
    }

    if (!result.ok) {
      try {
        o.store.deleteNote(createdNoteId);
      } catch {}
      if (result.error === 'Session running') {
        sendJson(res, 409, { error: 'Session running' });
        return true;
      }
      sendJson(res, 400, { error: result.error || 'Failed to start session' });
      return true;
    }

    sendJson(res, 200, { id: createdNoteId, note: `N-${createdNoteId}`, ...result });
    return true;
  }

  // Xoá ghi chú team: dòng DB + file trên main (lịch sử git giữ nguyên). Chỉ khi rảnh.
  if (pathname === '/api/notes/delete') {
    const parsed = z
      .object({ ids: z.array(z.number().int().positive()).min(1).max(500).optional(), all: z.literal(true).optional() })
      .refine((b) => !!b.ids !== !!b.all, 'ids or all')
      .safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid body' });
      return true;
    }
    if (o.host.busy?.()) {
      sendJson(res, 409, { error: 'Session running' });
      return true;
    }
    const activeProject = o.store.getActiveProject();
    if (!activeProject) {
      sendJson(res, 400, { error: 'No active project' });
      return true;
    }
    const picked = parsed.data.all
      ? o.store.listNotes(activeProject, 1_000_000)
      : parsed.data.ids!.map((id) => o.store.getNote(id)).filter((n) => n?.project === activeProject);
    // Ghi chú đang mở của phiên còn chờ/Resume được: phiên đó vẫn đọc note + ảnh → không xoá.
    // Chỉ phiên MỚI NHẤT của project mới Resume được; phiên cũ hơn (anh Zon 2026-11-15: N-4 kẹt vì phiên 14 out_of_turns từ lâu) không giữ note.
    const latest = o.store.getLatestSession(undefined, activeProject)?.id;
    const inUse = (n: (typeof picked)[number]) => {
      if (n?.status !== 'open' || !n.session_id || n.session_id !== latest) return false;
      const st = o.store.getSession(n.session_id)?.status;
      return st === 'running' || st === 'needs_owner' || st === 'stopped' || st === 'out_of_turns';
    };
    const skipped = picked.filter(inUse).map((n) => n!.id);
    const rows = picked.filter((n) => !inUse(n));
    if (rows.length === 0) {
      if (skipped.length) {
        sendJson(res, 409, { error: `Notes in use by a waiting session: ${skipped.map((i) => `N-${i}`).join(', ')}` });
        return true;
      }
      sendJson(res, 404, { error: 'No notes' });
      return true;
    }
    const names = rows.flatMap((n) => [`N-${n!.id}.md`, ...(n!.image ? [n!.image] : [])]);
    const pinKey = protectedShaKey(activeProject);
    let result: { mainSha: string; removed: string[] };
    try {
      result = removeInboxFromMain(activeProject, names, o.cfg.git?.protected_branch || 'main', o.store.getSetting(pinKey)?.trim() || '');
    } catch (err: any) {
      const msg = String(err?.message || err);
      sendJson(res, 409, { error: msg === 'dirty' ? 'Working tree is dirty' : msg === 'protected_branch_moved' ? 'protected_branch_moved' : 'Delete failed' });
      return true;
    }
    o.store.setSetting(pinKey, result.mainSha);
    for (const n of rows) o.store.deleteNote(n!.id);
    sendJson(res, 200, { ok: true, deleted: rows.map((n) => n!.id), skipped, removed: result.removed });
    return true;
  }
  return false;
}

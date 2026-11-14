// Route nhóm "settings" tách khỏi http.ts 2026-11-14 (docs/engineering-rules.md). Không đổi hành vi.
// handle*(…) trả true khi đã trả lời request.
import type { ServerResponse } from 'node:http';
import type { ServerOpts, SendJson } from '../http.ts';
import { z } from 'zod';
import { cleanKey, mbStatus, removeMbKey, saveMbKey, setMbEnabled } from '../../mb/vault.ts';
import { projectLessonsFile, readLessons, sharedLessonsFile, writeLessons, LESSONS_EDIT_MAX } from '../../knowledge/lessons.ts';
import { readChatSettings, readStandards, readUiDefaults, ChatSettingsSchema, StandardsSchema, UiDefaultsSchema, CHAT_KEY, STANDARDS_KEY, UI_DEFAULTS_KEY, TIMEZONES } from '../../standards.ts';

export async function handleSettingsGet(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
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

  // Settings (2026-11-14): chuẩn cho mọi project + mặc định dashboard.
  if (method === 'GET' && pathname === '/api/standards') {
    sendJson(res, 200, { standards: readStandards(o.store), ui: readUiDefaults(o.store), chat: readChatSettings(o.store), timezones: TIMEZONES });
    return true;
  }
  return false;
}

export async function handleSettingsPost(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  // Settings (2026-11-14): lưu chuẩn cho mọi project + mặc định dashboard (cả hai, hoặc một trong hai).
  if (pathname === '/api/standards') {
    const parsed = z.object({ standards: StandardsSchema.optional(), ui: UiDefaultsSchema.optional(), chat: ChatSettingsSchema.optional() }).safeParse(body);
    if (!parsed.success || (!parsed.data.standards && !parsed.data.ui && !parsed.data.chat)) {
      sendJson(res, 400, { error: 'Invalid settings' });
      return true;
    }
    if (parsed.data.standards) o.store.setSetting(STANDARDS_KEY, JSON.stringify(parsed.data.standards));
    if (parsed.data.ui) o.store.setSetting(UI_DEFAULTS_KEY, JSON.stringify(parsed.data.ui));
    if (parsed.data.chat) o.store.setSetting(CHAT_KEY, JSON.stringify(parsed.data.chat));
    sendJson(res, 200, { ok: true, standards: readStandards(o.store), ui: readUiDefaults(o.store), chat: readChatSettings(o.store) });
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

  // Boss key (decision 0003): set / enable / disable / remove. Trả trạng thái, KHÔNG BAO GIỜ trả key.
  if (pathname === '/api/mb') {
    const b = (body ?? {}) as { action?: unknown; key?: unknown };
    if (b.action === 'set') {
      const key = cleanKey(b.key);
      if (!key) {
        sendJson(res, 400, { error: 'Key must be 20-300 printable characters without spaces' });
        return true;
      }
      saveMbKey(o.store, o.cfg.host.data_dir, key);
    } else if (b.action === 'enable' || b.action === 'disable') {
      setMbEnabled(o.store, b.action === 'enable');
    } else if (b.action === 'remove') {
      removeMbKey(o.store);
    } else {
      sendJson(res, 400, { error: 'action must be set|enable|disable|remove' });
      return true;
    }
    const monitor = o.monitor ?? (o.host as any)?.monitor;
    try { await monitor?.refresh?.(Object.keys(o.cfg.agents).filter((a) => o.cfg.agents[a]!.provider === 'zai'), true); } catch {}
    sendJson(res, 200, mbStatus(o.store));
    return true;
  }
  return false;
}

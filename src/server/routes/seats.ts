// Route nhóm "seats/agent" tách khỏi http.ts 2026-11-14 (docs/engineering-rules.md). Không đổi hành vi.
// handle*(…) trả true khi đã trả lời request.
import type { ServerResponse } from 'node:http';
import type { ServerOpts, SendJson } from '../http.ts';
import { z } from 'zod';
import { AGENT_NAME_RE, AVATAR_MAX_BYTES, agentAvatarKey, agentAvatarVerKey, agentNameKey } from '../../agents/names.ts';
import { EffortSchema, ModelSchema, type Seat } from '../../config.ts';
import { agentEffortKey, agentModelKey } from '../../agents/model.ts';
import { effectiveSeats, seatSettingKey } from '../../store/db.ts';
import { detectImage } from '../inbox.ts';

export async function handleSeatsGet(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  // Avatar của Worker (chỉ ảnh đã kiểm magic bytes khi lưu; kiểm lại khi trả).
  const avatarMatch = pathname.match(/^\/api\/avatar\/([a-z0-9_-]{1,40})$/);
  if (method === 'GET' && avatarMatch) {
    const agent = avatarMatch[1]!;
    const b64 = Object.hasOwn(o.cfg.agents, agent) ? o.store.getSetting(agentAvatarKey(agent)) : null;
    const buf = b64 ? Buffer.from(b64, 'base64') : null;
    const det = buf ? detectImage(buf) : null;
    if (!buf || !det) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }
    res.writeHead(200, { 'Content-Type': det.mime, 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' });
    res.end(buf);
    return true;
  }
  return false;
}

export async function handleSeatsPost(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  if (pathname === '/api/agent') {
    const AgentBodySchema = z.object({
      agent: z.string(),
      model: z.union([z.literal(''), ModelSchema]).optional(),
      effort: EffortSchema.optional(),
      name: z.string().transform((x) => x.trim()).refine((x) => x === '' || AGENT_NAME_RE.test(x)).optional(),
      avatar: z.string().max(Math.ceil(AVATAR_MAX_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(),
    }).strict();
    const parsed = AgentBodySchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid model, effort or name' });
      return true;
    }
    const { agent, model, effort, name, avatar } = parsed.data;
    if (!Object.hasOwn(o.cfg.agents, agent)) {
      sendJson(res, 400, { error: `Unknown agent "${agent}"` });
      return true;
    }
    // Đổi tên chỉ là hiển thị: được đổi cả lúc phiên đang chạy. '' = về tên gốc.
    if ((name !== undefined || avatar !== undefined) && model === undefined && effort === undefined) {
      if (avatar !== undefined && avatar !== '' && !detectImage(Buffer.from(avatar, 'base64'))) {
        sendJson(res, 400, { error: 'Avatar must be PNG, JPEG or WebP' });
        return true;
      }
      if (name !== undefined) o.store.setSetting(agentNameKey(agent), name);
      if (avatar !== undefined) {
        o.store.setSetting(agentAvatarKey(agent), avatar);
        o.store.setSetting(agentAvatarVerKey(agent), avatar ? String(Date.now()) : '');
      }
      sendJson(res, 200, { ok: true, agent });
      return true;
    }
    if (o.host.busy?.()) {
      sendJson(res, 409, { error: 'Session running' });
      return true;
    }
    if (model !== undefined) o.store.setSetting(agentModelKey(agent), model);
    if (effort !== undefined) o.store.setSetting(agentEffortKey(agent), effort);
    sendJson(res, 200, { ok: true, agent, model: model ?? null, effort: effort ?? null });
    return true;
  }

  if (pathname === '/api/seat') {
    const SeatBodySchema = z.object({
      seat: z.string(),
      agent: z.string(),
    });
    const parsed = SeatBodySchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
      return true;
    }
    if (o.host.busy?.()) {
      sendJson(res, 409, { error: 'Session running' });
      return true;
    }
    const { seat, agent } = parsed.data;
    if (!Object.hasOwn(o.cfg.seats, seat)) {
      sendJson(res, 400, { error: `Invalid seat "${seat}"` });
      return true;
    }
    if (!Object.hasOwn(o.cfg.agents, agent)) {
      sendJson(res, 400, { error: `${agent} can't sit in ${seat}` });
      return true;
    }
    const agentCfg = o.cfg.agents[agent];
    if (!agentCfg || !agentCfg.can_sit.includes(seat as Seat)) {
      sendJson(res, 400, { error: `${agent} can't sit in ${seat}` });
      return true;
    }
    if (o.host.setSeat) {
      const result = await o.host.setSeat(seat as Seat, agent);
      if (!result.ok) {
        sendJson(res, result.status || 400, { error: result.error });
        return true;
      }
    } else {
      const current = effectiveSeats(o.cfg, o.store)[seat as Seat];
      o.store.setSetting(seatSettingKey(o.store.getActiveProject(), seat as Seat), agent);
      console.log(`${seat} seat: ${current} → ${agent}`);
    }
    sendJson(res, 200, { ok: true, seat, agent });
    return true;
  }
  return false;
}

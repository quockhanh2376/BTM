// Route nhóm "session/command" tách khỏi http.ts 2026-11-14 (docs/engineering-rules.md). Không đổi hành vi.
// handle*(…) trả true khi đã trả lời request.
import type { ServerResponse } from 'node:http';
import type { ServerOpts, SendJson } from '../http.ts';
import { z } from 'zod';
import type { Seat } from '../../config.ts';
import { effectiveSeats } from '../../store/db.ts';
import { activeAccountKeys } from '../../agents/accounts.ts';

export async function handleSessionPost(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  if (pathname === '/api/session') {
    const SessionSchema = z.object({
      goals: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(o.cfg.session.max_goals),
    });
    const parsed = SessionSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
      return true;
    }
    const result = await o.host.start(parsed.data.goals);
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === '/api/approve') {
    const ApproveSchema = z.object({}).passthrough();
    const parsed = ApproveSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid body' });
      return true;
    }
    const result = await o.host.approve();
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === '/api/resume') {
    const ResumeSchema = z.object({}).passthrough();
    const parsed = ResumeSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid body' });
      return true;
    }
    if (o.host.busy?.()) {
      sendJson(res, 409, { error: 'Session running' });
      return true;
    }
    if (o.host.resume) {
      const result = await o.host.resume();
      sendJson(res, result.ok ? 200 : (result.status || 400), result);
    } else {
      sendJson(res, 501, { error: 'Not implemented' });
    }
    return true;
  }

  if (pathname === '/api/stop') {
    const StopSchema = z.object({ seat: z.enum(['pm', 'dev', 'qc', 'audit']).optional() }).passthrough();
    const parsed = StopSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid body' });
      return true;
    }
    const result = await o.host.stop(parsed.data.seat);
    sendJson(res, result.status ?? 200, result);
    return true;
  }

  if (pathname === '/api/command') {
    const seatKeys = Object.keys(effectiveSeats(o.cfg, o.store));
    const allowedSeats = [...seatKeys, 'team', ...seatKeys.map((k) => `ask-${k}`)];
    const CommandSchema = z.object({
      to: z.string().refine((val) => allowedSeats.includes(val), { message: 'Invalid recipient' }),
      text: z.string().trim().min(1).max(2000),
    });
    const parsed = CommandSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
      return true;
    }
    const result = await o.host.command(parsed.data.to as Seat | 'team' | `ask-${Seat}`, parsed.data.text);
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === '/api/settings') {
    const SettingsSchema = z.object({
      autoApprove: z.boolean(),
    });
    const parsed = SettingsSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
      return true;
    }
    if (o.host.setAutoApprove) {
      await o.host.setAutoApprove(parsed.data.autoApprove);
    }
    sendJson(res, 200, { ok: true, autoApprove: parsed.data.autoApprove });
    return true;
  }

  if (pathname === '/api/energy/refresh') {
    const RefreshSchema = z.object({}).passthrough();
    const parsed = RefreshSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid body' });
      return true;
    }
    const monitor = o.monitor ?? (o.host as any)?.monitor;
    if (monitor) {
      await monitor.refresh(activeAccountKeys(o.cfg, o.store), true);
    }
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

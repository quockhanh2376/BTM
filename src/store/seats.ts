// Chọn agent cho từng ghế (settings + team/project.yaml), tách từ db.ts 2026-11-14. Không đổi hành vi.
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Seat } from '../config.ts';
import type { EnergyReading, EnergyWindow } from '../energy/quota.ts';
import type { LoginHealth, LoginState } from '../energy/login.ts';
import type { Ticket, TicketState, TicketType, TicketSize } from '../ticket/ticket.ts';
import { goalBranch } from '../ticket/goal.ts';
import { git } from '../git.ts';
import { parse as parseYaml } from 'yaml';

import type { Store } from './types.ts';

const SEATS: Seat[] = ['pm', 'dev', 'qc', 'audit'];

export function seatSettingKey(project: string | null | undefined, seat: Seat): string {
  return project ? `seat:${project}:${seat}` : `seat:${seat}`;
}

type SeatCfg = {
  seats: Record<Seat, string>;
  agents?: Record<string, { can_sit: Seat[] }>;
  git?: { protected_branch?: string };
};

const projectSeatsCache = new Map<string, { sha: string; seats: Partial<Record<Seat, string>>; backups: Partial<Record<Seat, string[]>>; warn: string[] }>();

// Đội hình theo project trong team/project.yaml – đọc từ nhánh được bảo vệ (main), không từ working tree:
// agent sửa được working tree nhưng không sửa được main.
export function readProjectSeats(repo: string, protectedBranch = 'main'): { seats: Partial<Record<Seat, string>>; backups: Partial<Record<Seat, string[]>>; warnings: string[] } {
  let sha: string;
  try {
    sha = git(repo, 'rev-parse', '-q', '--verify', `refs/heads/${protectedBranch}^{commit}`).trim();
  } catch {
    return { seats: {}, backups: {}, warnings: [] };
  }
  const hit = projectSeatsCache.get(repo);
  if (hit && hit.sha === sha) return { seats: hit.seats, backups: hit.backups, warnings: hit.warn };
  let seats: Partial<Record<Seat, string>> = {};
  let backups: Partial<Record<Seat, string[]>> = {};
  const warn: string[] = [];
  let text = '';
  try {
    text = git(repo, 'show', `${sha}:team/project.yaml`);
  } catch {
    text = '';
  }
  if (text) {
    try {
      const doc = parseYaml(text) as { seats?: unknown; seats_backup?: unknown } | null;
      const raw = doc && typeof doc === 'object' ? doc.seats : undefined;
      if (raw !== undefined && raw !== null) {
        if (typeof raw !== 'object' || Array.isArray(raw)) {
          warn.push('team/project.yaml: seats must map seat → agent');
        } else {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            if ((SEATS as string[]).includes(k) && typeof v === 'string') seats[k as Seat] = v.trim();
            else warn.push(`team/project.yaml: ignored seats.${k}`);
          }
        }
      }
      // Plan 6 Task 2: seats_backup theo project (ghi đè btm.config.yaml), cùng nguồn main.
      const rawB = doc && typeof doc === 'object' ? doc.seats_backup : undefined;
      if (rawB && typeof rawB === 'object' && !Array.isArray(rawB)) {
        for (const [k, v] of Object.entries(rawB as Record<string, unknown>)) {
          if ((SEATS as string[]).includes(k) && Array.isArray(v) && v.every((x) => typeof x === 'string')) backups[k as Seat] = v as string[];
          else warn.push(`team/project.yaml: ignored seats_backup.${k}`);
        }
      }
    } catch {
      seats = {};
      backups = {};
      warn.push('team/project.yaml: invalid YAML, using default team');
    }
  }
  projectSeatsCache.set(repo, { sha, seats, backups, warn });
  return { seats, backups, warnings: warn };
}

// Thứ tự: dashboard theo project > team/project.yaml (main) > dashboard cũ (không theo project) > btm.config.yaml.
// Agent lạ hoặc không có ghế trong can_sit → bỏ qua, ghi cảnh báo. Áp cho cả 4 ghế (audit '' = không có Audit).
export function resolveSeats(
  cfg: SeatCfg,
  store?: Pick<Store, 'getSetting'> & Partial<Pick<Store, 'getActiveProject'>> | null,
  project?: string | null
): { seats: Record<Seat, string>; warnings: string[] } {
  const seats: Record<Seat, string> = { ...cfg.seats };
  const warnings: string[] = [];
  const proj = project ?? store?.getActiveProject?.() ?? null;
  const valid = (seat: Seat, id: string) =>
    !cfg.agents || (Object.hasOwn(cfg.agents, id) && Boolean(cfg.agents[id]?.can_sit?.includes(seat)));
  const apply = (seat: Seat, id: string | null | undefined, source: string) => {
    if (!id) return;
    if (valid(seat, id)) seats[seat] = id;
    else warnings.push(`Ignored ${source}: ${seat} = "${id}" (unknown or not allowed)`);
  };
  const fromFile = proj ? readProjectSeats(proj, cfg.git?.protected_branch || 'main') : { seats: {}, backups: {}, warnings: [] };
  warnings.push(...fromFile.warnings);
  for (const seat of SEATS) {
    apply(seat, store?.getSetting(seatSettingKey(null, seat)), 'legacy override');
    apply(seat, fromFile.seats[seat], 'team/project.yaml');
    if (proj) apply(seat, store?.getSetting(seatSettingKey(proj, seat)), 'dashboard override');
  }
  return { seats, warnings };
}

export function effectiveSeats(
  cfg: SeatCfg,
  store?: Pick<Store, 'getSetting'> & Partial<Pick<Store, 'getActiveProject'>> | null,
  project?: string | null
): Record<Seat, string> {
  return resolveSeats(cfg, store, project).seats;
}


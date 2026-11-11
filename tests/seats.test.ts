import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, resolveSeats, effectiveSeats, seatSettingKey } from '../src/store/db.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const cfg = {
  seats: { pm: 'elon', dev: 'jacky', qc: 'jenny', audit: '' },
  agents: {
    elon: { can_sit: ['pm', 'qc', 'audit'] },
    jacky: { can_sit: ['dev'] },
    jenny: { can_sit: ['qc', 'dev'] },
  },
  git: { protected_branch: 'main' },
} as any;

function repo(projectYaml?: string): string {
  const r = mkdtempSync(join(tmpdir(), 'btm-seats-'));
  roots.push(r);
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: r });
  g('init', '-q', '-b', 'main');
  mkdirSync(join(r, 'team'));
  writeFileSync(join(r, 'team', 'project.yaml'), projectYaml ?? 'key: GTM\n');
  g('add', '.'); g('commit', '-qm', 'base');
  return r;
}

describe('P5-T4: đội hình theo project (cả 4 ghế)', () => {
  it('team/project.yaml trên main: PM + Audit cùng elon; project khác giữ mặc định', () => {
    const a = repo('key: A\nseats:\n  pm: elon\n  audit: elon\n');
    const b = repo();
    expect(effectiveSeats(cfg, null, a)).toEqual({ pm: 'elon', dev: 'jacky', qc: 'jenny', audit: 'elon' });
    expect(effectiveSeats(cfg, null, b).audit).toBe('');
  });

  it('project.yaml chỉ sửa ở working tree (chưa lên main) → không có hiệu lực', () => {
    const a = repo();
    writeFileSync(join(a, 'team', 'project.yaml'), 'seats:\n  qc: elon\n');
    expect(effectiveSeats(cfg, null, a).qc).toBe('jenny');
  });

  it('đổi ghế trên dashboard theo project: A đổi không ảnh hưởng B; ghi đè project.yaml; áp được cho audit', () => {
    const a = repo('seats:\n  qc: elon\n');
    const b = repo();
    const store = openStore(':memory:');
    store.setSetting(seatSettingKey(a, 'qc'), 'jenny');
    store.setSetting(seatSettingKey(a, 'audit'), 'elon');
    expect(effectiveSeats(cfg, store, a)).toMatchObject({ qc: 'jenny', audit: 'elon' });
    expect(effectiveSeats(cfg, store, b)).toMatchObject({ qc: 'jenny', audit: '' });
    store.setActiveProject(a);
    expect(effectiveSeats(cfg, store).audit).toBe('elon'); // không truyền project → dùng active project
    store.close();
  });

  it('agent lạ / không được ngồi ghế → bỏ qua kèm cảnh báo; YAML lỗi → mặc định + cảnh báo; khoá cũ seat:<ghế> vẫn đọc', () => {
    const a = repo('seats:\n  audit: ghost\n  dev: elon\n  boss: elon\n');
    const r = resolveSeats(cfg, null, a);
    expect(r.seats).toEqual(cfg.seats);
    expect(r.warnings.join('\n')).toContain('ghost');
    expect(r.warnings.join('\n')).toContain('"elon"');
    expect(r.warnings.join('\n')).toContain('seats.boss');
    const bad = repo('seats: [x\n');
    expect(resolveSeats(cfg, null, bad).warnings.join('\n')).toContain('YAML');
    const store = openStore(':memory:');
    store.setSetting('seat:qc', 'elon');
    expect(effectiveSeats(cfg, store, bad).qc).toBe('elon');
    store.close();
  });
});

describe('P6-T2: seats_backup theo project', () => {
  it('đọc seats_backup từ team/project.yaml trên main; mục sai định dạng bị bỏ qua kèm cảnh báo', async () => {
    const { readProjectSeats } = await import('../src/store/db.ts');
    const a = repo('seats_backup:\n  dev: [jenny]\n  qc: elon\n');
    const r = readProjectSeats(a);
    expect(r.backups).toEqual({ dev: ['jenny'] });
    expect(r.warnings.join(' ')).toContain('seats_backup.qc');
  });
});

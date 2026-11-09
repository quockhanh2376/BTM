import { describe, it, expect } from 'vitest';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo } from './helpers.ts';
import { git, headSha } from '../src/git.ts';
import { snapshotTurn, guardAgentTurn } from '../src/core/guard.ts';

const TEST_AUTHOR = ['-c', 'user.name=dev', '-c', 'user.email=dev@btm.local'];

describe('P4-FIX-D: Guard agent turn hardening', () => {
  it('B1: agent commit lên main rồi git tag main <sha cũ> → refs/heads/main vẫn được khôi phục', () => {
    const repo = tmpRepo({ 'sample.txt': 'initial' });
    const originalMainSha = git(repo, 'rev-parse', 'refs/heads/main').trim();

    // Tạo nhánh goal/G1-feat và checkout
    git(repo, 'checkout', '-b', 'goal/G1-feat');

    const snapshot = snapshotTurn(repo, 'goal/G1-feat', 'main');

    // Agent gian lận: checkout main, commit, rồi tạo tag main trỏ về sha cũ
    git(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'evil.txt'), 'evil');
    git(repo, 'add', 'evil.txt');
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'evil on main'], { cwd: repo });
    const evilMainSha = git(repo, 'rev-parse', 'refs/heads/main').trim();
    expect(evilMainSha).not.toBe(originalMainSha);

    // Tạo tag main trỏ về sha cũ
    execFileSync('git', ['tag', 'main', originalMainSha], { cwd: repo });
    // git rev-parse main lúc này sẽ trả về tag sha (originalMainSha) nếu không dùng refs/heads!
    expect(execFileSync('git', ['rev-parse', 'main'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(originalMainSha);

    const guardRes = guardAgentTurn(repo, snapshot, 'dev');

    // refs/heads/main phải được khôi phục về originalMainSha
    const finalMainSha = git(repo, 'rev-parse', 'refs/heads/main').trim();
    expect(finalMainSha).toBe(originalMainSha);
    expect(guardRes.modifiedProtectedBranch).toBe(true);
  });

  it('B2: nhánh goal khác bị sửa / xoá / tạo mới → khôi phục bằng update-ref, vi phạm agent_modified_other_goal', () => {
    const repo = tmpRepo({ 'sample.txt': 'initial' });

    // Tạo nhánh goal khác: goal/G2-other
    git(repo, 'checkout', '-b', 'goal/G2-other');
    writeFileSync(join(repo, 'g2.txt'), 'g2 initial');
    git(repo, 'add', 'g2.txt');
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'g2 init'], { cwd: repo });
    const g2ShaBefore = git(repo, 'rev-parse', 'refs/heads/goal/G2-other').trim();

    // Tạo nhánh goal khác nữa: goal/G3-to-delete
    git(repo, 'checkout', '-b', 'goal/G3-to-delete');
    const g3ShaBefore = git(repo, 'rev-parse', 'refs/heads/goal/G3-to-delete').trim();

    // Nhánh đang làm: goal/G1-current
    git(repo, 'checkout', '-b', 'goal/G1-current');

    const snapshot = snapshotTurn(repo, 'goal/G1-current', 'main');

    // Agent sửa goal/G2-other
    git(repo, 'checkout', 'goal/G2-other');
    writeFileSync(join(repo, 'g2.txt'), 'g2 modified by rogue agent');
    git(repo, 'add', 'g2.txt');
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'tamper g2'], { cwd: repo });

    // Agent xoá goal/G3-to-delete
    execFileSync('git', ['branch', '-D', 'goal/G3-to-delete'], { cwd: repo });

    // Agent tạo goal/G4-rogue mới
    execFileSync('git', ['branch', 'goal/G4-rogue'], { cwd: repo });

    // Trở về nhánh goal/G1-current
    git(repo, 'checkout', 'goal/G1-current');

    const guardRes = guardAgentTurn(repo, snapshot, 'dev');

    expect(guardRes.modifiedOtherGoal).toBe(true);

    // goal/G2-other được phục hồi
    const g2ShaAfter = git(repo, 'rev-parse', 'refs/heads/goal/G2-other').trim();
    expect(g2ShaAfter).toBe(g2ShaBefore);

    // goal/G3-to-delete được tạo lại
    const g3ShaAfter = git(repo, 'rev-parse', 'refs/heads/goal/G3-to-delete').trim();
    expect(g3ShaAfter).toBe(g3ShaBefore);

    // goal/G4-rogue bị xoá
    expect(() => git(repo, 'rev-parse', '--verify', 'refs/heads/goal/G4-rogue')).toThrow();
  });

  it('B7: main bị xoá trong lượt → tạo lại bằng update-ref, vi phạm agent_modified_protected_branch', () => {
    const repo = tmpRepo({ 'sample.txt': 'initial' });
    const originalMainSha = git(repo, 'rev-parse', 'refs/heads/main').trim();

    git(repo, 'checkout', '-b', 'goal/G1-feat');
    const snapshot = snapshotTurn(repo, 'goal/G1-feat', 'main');

    // Agent xoá main
    execFileSync('git', ['branch', '-D', 'main'], { cwd: repo });
    expect(() => git(repo, 'rev-parse', '--verify', 'refs/heads/main')).toThrow();

    const guardRes = guardAgentTurn(repo, snapshot, 'dev');

    expect(guardRes.modifiedProtectedBranch).toBe(true);
    const restoredMainSha = git(repo, 'rev-parse', 'refs/heads/main').trim();
    expect(restoredMainSha).toBe(originalMainSha);
  });

  it('B7: nhánh goal bị xoá trong lượt → tạo lại tại preHead rồi checkout, vi phạm agent_switched_branch', () => {
    const repo = tmpRepo({ 'sample.txt': 'initial' });

    git(repo, 'checkout', '-b', 'goal/G1-feat');
    const preHead = headSha(repo);
    const snapshot = snapshotTurn(repo, 'goal/G1-feat', 'main');

    // Agent switch sang main rồi xoá nhánh goal
    git(repo, 'checkout', 'main');
    execFileSync('git', ['branch', '-D', 'goal/G1-feat'], { cwd: repo });
    expect(() => git(repo, 'rev-parse', '--verify', 'refs/heads/goal/G1-feat')).toThrow();

    const guardRes = guardAgentTurn(repo, snapshot, 'dev');

    expect(guardRes.switchedBranch).toBe(true);
    const currentBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    expect(currentBranch).toBe('goal/G1-feat');
    expect(headSha(repo)).toBe(preHead);
  });
});

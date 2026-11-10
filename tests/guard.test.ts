import { describe, it, expect } from 'vitest';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo } from './helpers.ts';
import { git, headSha, commitAll } from '../src/git.ts';
import { snapshotTurn, guardAgentTurn, recoverInterruptedTurn } from '../src/core/guard.ts';
import { openStore } from '../src/store/db.ts';

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

  it('C1: agent thêm gpg.program và clean filter vào .git/config + .git/info/attributes → guard khôi phục config trước mọi lệnh git, script không chạy khi commitAll, có vi phạm git_config_tampered', () => {
    const repo = tmpRepo({ 'sample.txt': 'initial\n' });
    git(repo, 'checkout', '-b', 'goal/G1-feat');

    const configPath = join(repo, '.git', 'config');
    const attrPath = join(repo, '.git', 'info', 'attributes');
    const originalConfig = readFileSync(configPath, 'utf8');

    const snapshot = snapshotTurn(repo, 'goal/G1-feat', 'main');
    expect(snapshot.gitConfig).toBe(originalConfig);
    expect(snapshot.gitInfoAttributes).toBe('');

    const markerFile = join(repo, 'pwned-marker.txt').replace(/\\/g, '/');
    const evilScript = join(repo, 'evil-script.js').replace(/\\/g, '/');
    writeFileSync(
      evilScript,
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(markerFile)}, 'pwned'); process.stdout.write( fs.readFileSync(0, 'utf8') );\n`,
      'utf8'
    );
    const nodeCmd = `node "${evilScript}"`;

    writeFileSync(
      configPath,
      `${originalConfig}\n[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n[gpg]\n\tprogram = ${nodeCmd}\n[filter "evil"]\n\tclean = ${nodeCmd}\n\tsmudge = ${nodeCmd}\n`,
      'utf8'
    );
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(attrPath, '* filter=evil\n', 'utf8');
    writeFileSync(join(repo, 'sample.txt'), 'modified by agent\n', 'utf8');

    const guardRes = guardAgentTurn(repo, snapshot, 'dev');

    expect(guardRes.gitConfigTampered).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
    expect(existsSync(attrPath) ? readFileSync(attrPath, 'utf8') : '').toBe('');
    expect(existsSync(markerFile)).toBe(false);

    // Sau guard, BTM chạy commitAll → script độc KHÔNG được kích hoạt
    writeFileSync(join(repo, 'sample.txt'), 'clean btm change\n', 'utf8');
    commitAll(repo, 'G1: btm commit', { name: 'btm', email: 'btm@btm.local' });
    expect(existsSync(markerFile)).toBe(false);
  });

  it('C2: snapshotTurn ghim protected_sha:<repo> lần đầu và phát hiện protected_branch_moved ở lượt sau thay vì coi main bẩn là gốc', () => {
    const repo = tmpRepo({ 'sample.txt': 'initial\n' });
    const store = openStore(':memory:');
    const mainSha0 = git(repo, 'rev-parse', 'refs/heads/main').trim();

    git(repo, 'checkout', '-b', 'goal/G1-feat');
    writeFileSync(join(repo, 'sample.txt'), 'goal commit\n');
    commitAll(repo, 'G1: commit on goal', { name: 'dev', email: 'dev@btm.local' });
    const goalHead = headSha(repo);

    // Lần đầu snapshotTurn → ghim protected_sha:<repo> = mainSha0
    const snap1 = snapshotTurn(repo, 'goal/G1-feat', 'main', store, 'dev');
    expect(snap1.protectedHead).toBe(mainSha0);
    expect(store.getSetting(`protected_sha:${repo}`)).toBe(mainSha0);
    guardAgentTurn(repo, snap1, 'dev');

    // Giả lập tiến trình ngoài lượt dịch chuyển refs/heads/main sang goalHead
    git(repo, 'update-ref', 'refs/heads/main', goalHead);
    expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(goalHead);

    // Lượt sau gọi snapshotTurn → KHÔNG coi goalHead là gốc mới, KHÔNG tự update-ref ở snapshotTurn, báo protectedBranchMoved
    const snap2 = snapshotTurn(repo, 'goal/G1-feat', 'main', store, 'dev');
    expect(snap2.protectedHead).toBe(mainSha0);
    expect(snap2.protectedBranchMoved).toBe(true);
    expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(goalHead);

    // Chỉ guardAgentTurn mới khôi phục về sha snapshot
    const guardRes2 = guardAgentTurn(repo, snap2, 'dev');
    expect(guardRes2.protectedBranchMoved).toBe(true);
    expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(mainSha0);

    store.close();
  });

  it('C1 v2: HOME/GIT_CONFIG_GLOBAL trỏ tới config có filter.x.clean + attributes → BTM commit không chạy script', () => {
    const repo = tmpRepo({ 'sample.txt': 'initial\n', '.gitattributes': '* filter=x\n' });
    const fakeHome = join(repo, '.fake-home');
    mkdirSync(fakeHome, { recursive: true });
    const fakeGlobalCfg = join(fakeHome, '.gitconfig');
    const markerFile = join(repo, 'global-pwned.txt').replace(/\\/g, '/');
    const evilScript = join(repo, 'global-evil.js').replace(/\\/g, '/');

    writeFileSync(
      evilScript,
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(markerFile)}, 'pwned'); process.stdout.write(fs.readFileSync(0, 'utf8'));\n`,
      'utf8'
    );
    const nodeCmd = `node "${evilScript}"`;
    writeFileSync(
      fakeGlobalCfg,
      `[filter "x"]\n\tclean = ${nodeCmd}\n\tsmudge = ${nodeCmd}\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${nodeCmd}\n`,
      'utf8'
    );

    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.GIT_CONFIG_GLOBAL = fakeGlobalCfg;

    try {
      writeFileSync(join(repo, 'sample.txt'), 'updated content\n', 'utf8');
      commitAll(repo, 'G1: commit with poisoned global gitconfig', {
        name: 'btm',
        email: 'btm@btm.local',
      });
      expect(existsSync(markerFile)).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal;
    }
  });

  it.skipIf(process.platform === 'win32')('C8: tên pathspec đặc biệt không chặn dọn ignored; node_modules lồng nhau luôn được giữ', () => {
    const repo = tmpRepo({
      'sample.txt': 'initial\n',
      ':(bad)': 'ordinary untracked file\n',
      '.gitignore': 'node_modules/\n.env\ndist/\n',
    });
    git(repo, 'checkout', '-b', 'goal/G1-feat');

    const snap = snapshotTurn(repo, 'goal/G1-feat', 'main', undefined, 'dev');

    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist', 'x.js'), 'console.log(1);\n', 'utf8');
    writeFileSync(join(repo, '.env'), 'LOCAL=1\n', 'utf8');
    mkdirSync(join(repo, 'packages', 'x', 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'x', 'node_modules', 'a.js'), 'keep\n', 'utf8');

    const devRes = guardAgentTurn(repo, snap, 'dev');
    expect(devRes.ignoredCleanedCount).toBe(2);
    expect(existsSync(join(repo, 'dist', 'x.js'))).toBe(false);
    expect(existsSync(join(repo, '.env'))).toBe(false);
    expect(existsSync(join(repo, ':(bad)'))).toBe(true);
    expect(existsSync(join(repo, 'packages', 'x', 'node_modules', 'a.js'))).toBe(true);
  });

});

describe('P4-FIX-H: review 4', () => {
  const memStore = () => {
    const m = new Map<string, string>();
    return { getSetting: (k: string) => m.get(k) ?? null, setSetting: (k: string, v: string) => void m.set(k, v) } as any;
  };

  it('D9: chỉ xoá đúng file ignored mới; không xoá thư mục chứa source; giữ file mới trong thư mục ignored có sẵn (.venv)', () => {
    const repo = tmpRepo({ 'src/app.ts': 'export {};\n', '.gitignore': '*.log\n.venv/\ndist/\n' });
    git(repo, 'checkout', '-b', 'goal/G1-feat');
    mkdirSync(join(repo, '.venv'), { recursive: true });
    writeFileSync(join(repo, '.venv', 'a.py'), 'a\n');
    const snap = snapshotTurn(repo, 'goal/G1-feat', 'main', undefined, 'dev');

    writeFileSync(join(repo, '.venv', 'b.py'), 'b\n');
    writeFileSync(join(repo, 'src', 'foo.log'), 'log\n');
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist', 'x.js'), 'x\n');

    const res = guardAgentTurn(repo, snap, 'dev');
    expect(existsSync(join(repo, 'src', 'app.ts'))).toBe(true);
    expect(existsSync(join(repo, 'src', 'foo.log'))).toBe(false);
    expect(existsSync(join(repo, 'dist', 'x.js'))).toBe(false);
    expect(existsSync(join(repo, '.venv', 'b.py'))).toBe(true);
    expect(res.ignoredCleanedCount).toBe(2);
  });

  it('D7: lượt chỉ thêm core.hooksPath (husky prepare) → khôi phục config nhưng không tính git_config_tampered', () => {
    const repo = tmpRepo({ 'a.txt': 'a\n' });
    git(repo, 'checkout', '-b', 'goal/G1-feat');
    const before = readFileSync(join(repo, '.git', 'config'), 'utf8');
    const snap = snapshotTurn(repo, 'goal/G1-feat', 'main', undefined, 'dev');
    execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: repo });
    const res = guardAgentTurn(repo, snap, 'dev');
    expect(res.gitConfigTampered).toBe(false);
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toBe(before);
  });

  it('D7: thêm filter (không phải hooksPath) vẫn là git_config_tampered', () => {
    const repo = tmpRepo({ 'a.txt': 'a\n' });
    git(repo, 'checkout', '-b', 'goal/G1-feat');
    const snap = snapshotTurn(repo, 'goal/G1-feat', 'main', undefined, 'dev');
    execFileSync('git', ['config', 'filter.x.clean', 'sh evil.sh'], { cwd: repo });
    expect(guardAgentTurn(repo, snap, 'dev').gitConfigTampered).toBe(true);
  });

  it('D4: phục hồi lượt bị ngắt khi main đã đổi (anh merge tay) → không kéo main về, không xoá file ignored, needs_owner', () => {
    const repo = tmpRepo({ 'a.txt': 'a\n', '.gitignore': '.env\n' });
    git(repo, 'checkout', '-b', 'goal/G1-feat');
    const store = memStore();
    snapshotTurn(repo, 'goal/G1-feat', 'main', store, 'dev');

    git(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'owner.txt'), 'owner\n');
    git(repo, 'add', 'owner.txt');
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'owner merge'], { cwd: repo });
    const ownerMain = git(repo, 'rev-parse', 'refs/heads/main').trim();
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');

    const res = recoverInterruptedTurn(store, repo);
    expect(res?.needsOwner).toBe('recovered_interrupted_turn');
    expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(ownerMain);
    expect(existsSync(join(repo, '.env'))).toBe(true);
    expect(store.getSetting(`turn_guard:${repo}`)).toBeFalsy();
  });
});

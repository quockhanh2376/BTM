// Plan 7: kiểm tra an toàn btm-account + đọc/ghi token dưới user tài khoản. Chạy trên VM bằng user agent, SAU khi prep:
//   sudo -u agent bash -lc 'cd /srv/agent-projects/btm && npx tsx team/bin/p7-account-check.mjs'
// Không in nội dung token nào. Tạo user thử btm-jacky-p7check (giữ lại; xoá tay: sudo userdel -r btm-jacky-p7check).
import { execFileSync } from 'node:child_process';
const { addWorkerUser, importTokens, exportTokens } = await import('/srv/agent-projects/btm/src/isolation/account-admin.ts');
const cfg = { host: { worker_prefix: 'btm-' } };
const ok = (name, pass) => console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
const sudoAdd = (...args) => {
  try {
    execFileSync('sudo', ['-n', '/usr/local/bin/btm-account', ...args], { stdio: 'pipe', timeout: 30000 });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
};
const sh = (cmd) => execFileSync('sh', ['-c', cmd], { encoding: 'utf8' }).trim();

for (const bad of ['root', 'admzon', 'agent', 'btm-x;id', 'btm-', '../btm-x', 'BTM-X']) ok(`add ${bad} bị từ chối`, sudoAdd('add', bad) !== 0);
ok('lệnh khác add bị sudoers chặn', sudoAdd('del', 'btm-elon') !== 0);
ok('thừa tham số bị từ chối', sudoAdd('add', 'btm-x', 'y') !== 0);
const passwd0 = sh('stat -c %Y /etc/passwd');
ok('add user worker đã có (btm-elon) → 0, không đổi gì', sudoAdd('add', 'btm-elon') === 0 && sh('stat -c %Y /etc/passwd') === passwd0);

addWorkerUser(cfg, 'jacky-p7check');
ok('tạo user mới thuộc btm-workers', sh('id -nG btm-jacky-p7check').split(' ').includes('btm-workers'));
ok('home 700', sh('stat -c %a /home/btm-jacky-p7check') === '700');
ok('workspace riêng', sh('stat -c %U:%a /srv/btm-work/btm-jacky-p7check') === 'btm-jacky-p7check:700');
ok('cron.deny có user', sh('grep -cx btm-jacky-p7check /etc/cron.deny') === '1');

importTokens(cfg, 'jacky-p7check', 'codex-cli', { '.codex/auth.json': '{"p7":"check"}' });
ok('file token 600, chủ là user tài khoản', sh('sudo -n -u btm-jacky-p7check /usr/local/bin/btm-worker-exec /home/btm-jacky-p7check -- stat -c %U:%a .codex/auth.json') === 'btm-jacky-p7check:600');
ok('export đọc lại đúng', exportTokens(cfg, 'jacky-p7check', 'codex-cli')['.codex/auth.json'] === '{"p7":"check"}');

// Symlink do agent đặt trong home của nó: ghi không được thoát ra ngoài home.
sh('sudo -n -u btm-jacky-p7check /usr/local/bin/btm-worker-exec /home/btm-jacky-p7check -- sh -c "rm -rf .codex && ln -s /srv/btm-work .codex"');
let escaped = false;
try {
  importTokens(cfg, 'jacky-p7check', 'codex-cli', { '.codex/auth.json': '{"x":1}' });
  escaped = true;
} catch {}
ok('symlink ra ngoài home bị chặn', !escaped && sh('test -e /srv/btm-work/auth.json && echo BAD || echo CLEAN') === 'CLEAN');
ok('user tài khoản không đọc được token của Worker khác', sh('sudo -n -u btm-jacky-p7check /usr/local/bin/btm-worker-exec /home/btm-jacky-p7check -- sh -c "cat /home/btm-elon/.claude/.credentials.json >/dev/null 2>&1 && echo READ || echo BLOCKED"') === 'BLOCKED');

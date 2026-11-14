// Thư viện skill + cổng bảo mật 2 người kiểm (anh Zon 2026-11-14): Boss kiểm, Finn (Claude) kiểm chéo, đủ an toàn mới dùng được.
// Spec: docs/superpowers/specs/2026-11-14-agent-skills-design.md
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Seat } from '../config.ts';
import { effectiveSeats, type Store } from '../store/db.ts';
import type { Runner } from '../runner/run.ts';
import { usableAccounts } from '../agents/accounts.ts';
import { agentNameKey } from '../agents/names.ts';
import { mbStatus } from '../mb/vault.ts';
import { git } from '../git.ts';
import { readProjectKey } from '../ticket/goal.ts';
import { parseGithubUrl } from '../meeting/github.ts';
import {
  activeSkills, fitsProject, gateVerdict, parseReview, parseSkillMd, reviewPrompt, skillsBlock, staticScan, suggestSeats,
  SEATS, SKILLS_MAX, SKILL_MAX_CHARS, type ProjectSignals, type Skill,
} from './core.ts';

export const SKILLS_KEY = 'skills';

export function readSkills(store: Pick<Store, 'getSetting'>): Skill[] {
  try {
    const v = JSON.parse(store.getSetting(SKILLS_KEY) || '[]');
    return Array.isArray(v) ? (v as Skill[]) : [];
  } catch {
    return [];
  }
}
export const skillFile = (dataDir: string, id: number) => join(dataDir, 'skills', `${id}.md`);
export function skillText(dataDir: string, id: number): string {
  try { return readFileSync(skillFile(dataDir, id), 'utf8'); } catch { return ''; }
}

/** Dấu hiệu của project để gợi ý skill: đuôi file, có giao diện, có test. */
export function projectSignals(repo: string): ProjectSignals {
  let files: string[] = [];
  try { files = git(repo, 'ls-files').split(/\r?\n/).filter((f) => f && !f.startsWith('team/')); } catch { /* không phải repo */ }
  const exts = [...new Set(files.map((f) => /\.([A-Za-z0-9]+)$/.exec(f)?.[1]?.toLowerCase()).filter((e): e is string => Boolean(e)))];
  return { exts, hasUi: exts.some((e) => /^(html|css|jsx|tsx|vue|svelte)$/.test(e)), hasTests: files.some((f) => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(f)) };
}

/** Chữ skill cho prompt của một ghế ở một project (rỗng nếu không có skill bật). Lỗi → rỗng, không làm hỏng lượt. */
export function skillsFor(store: Pick<Store, 'getSetting'>, dataDir: string, project: string, seat: Seat): string {
  try {
    const key = readProjectKey(project);
    return skillsBlock(activeSkills(readSkills(store), seat, key).map((s) => ({ name: s.name, text: skillText(dataDir, s.id) })).filter((x) => x.text));
  } catch {
    return '';
  }
}

export interface SkillsLaneDeps {
  cfg: Config;
  store: Store;
  runner: Runner;
  logDir: string;
  isolated: boolean;
  hostBusy: () => boolean;
  gate?: (agent: string) => { ok: true } | { ok: false; reason: string };
  fetchFn?: typeof fetch;
}
type Fail = { ok: false; status: number; error: string };
export interface GithubCandidate { path: string; name: string; description: string; license: string; chars: number }
/** Kết quả tìm trên skills.sh: repo nguồn + tên skill + lượt cài; trust theo ngưỡng của find-skills (≥1000 ok, ≥100 cẩn thận, còn lại rủi ro). */
export interface FoundSkill { source: string; skillId: string; name: string; installs: number; trust: 'ok' | 'caution' | 'risky' }
export const SKILLS_SEARCH_URL = 'https://skills.sh/api/search';
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** "https://github.com/o/r", "o/r" hoặc "o/r@skill" → repo (+ skill). Không phải dạng đó (vd từ khoá) → null. */
export function repoRef(input: string): { owner: string; repo: string; url: string; skill?: string } | null {
  const text = String(input || '').trim();
  const viaUrl = parseGithubUrl(text);
  if (viaUrl) return viaUrl;
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:@([A-Za-z0-9][A-Za-z0-9._-]{0,80}))?$/.exec(text);
  if (!m) return null;
  const repo = m[2]!.replace(/\.git$/i, '');
  return { owner: m[1]!, repo, url: `https://github.com/${m[1]}/${repo}`, ...(m[3] ? { skill: m[3] } : {}) };
}

export function createSkillsLane(d: SkillsLaneDeps) {
  let inFlight = false;
  const dataDir = d.cfg.host.data_dir;
  const nameOf = (agent: string) => d.store.getSetting(agentNameKey(agent)) || agent;
  const save = (list: Skill[]) => d.store.setSetting(SKILLS_KEY, JSON.stringify(list));
  const patch = (id: number, fn: (s: Skill) => Skill) => save(readSkills(d.store).map((s) => (s.id === id ? fn(s) : s)));

  async function getText(url: string): Promise<string | null> {
    try {
      const res = await (d.fetchFn ?? fetch)(url, { headers: { 'User-Agent': 'btm-skills', Accept: 'application/vnd.github+json, text/plain' }, signal: AbortSignal.timeout(10_000) });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  /** Thêm một skill vào khu chờ: Core quét ngay; mức high → từ chối luôn, không tốn lượt agent. */
  function add(raw: string, source: string): { ok: true; skill: Skill } | Fail {
    const list = readSkills(d.store);
    if (list.length >= SKILLS_MAX) return { ok: false, status: 400, error: `At most ${SKILLS_MAX} skills` };
    const text = String(raw || '').replace(/\r\n/g, '\n').trim();
    if (text.length < 40) return { ok: false, status: 400, error: 'Skill text is too short' };
    if (text.length > SKILL_MAX_CHARS) return { ok: false, status: 400, error: `Skill is longer than ${SKILL_MAX_CHARS} characters` };
    const meta = parseSkillMd(text);
    const scan = staticScan(text);
    const verdict = gateVerdict(scan, []);
    const id = list.reduce((mx, s) => Math.max(mx, s.id), 0) + 1;
    try {
      mkdirSync(join(dataDir, 'skills'), { recursive: true, mode: 0o700 });
      writeFileSync(skillFile(dataDir, id), text, { mode: 0o600 });
    } catch {
      return { ok: false, status: 500, error: 'Could not store the skill' };
    }
    const skill: Skill = {
      id, name: meta.name, description: meta.description, license: meta.license, source, version: new Date().toISOString(), chars: text.length,
      status: verdict.status, ...(verdict.note ? { note: verdict.note } : {}), scan, reviews: [],
      seats: suggestSeats(meta.name, meta.description), projects: 'all', on: false,
    };
    save([...list, skill]);
    void tick();
    return { ok: true, skill };
  }

  /** Liệt kê các SKILL.md trong repo GitHub công khai (chưa nhập gì). */
  /** Đường dẫn các SKILL.md trong repo (bỏ bản sao trong thư mục ẩn như .openclaw/…). */
  async function skillPaths(owner: string, repo: string): Promise<string[]> {
    const treeJson = await getText(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`);
    let paths: string[] = [];
    try {
      const tree = (JSON.parse(treeJson ?? '{}') as { tree?: Array<{ path?: unknown; type?: unknown }> }).tree;
      if (Array.isArray(tree)) paths = tree.filter((t) => t.type === 'blob' && typeof t.path === 'string').map((t) => String(t.path));
    } catch { /* cây lỗi */ }
    return paths.filter((p) => /(^|\/)SKILL\.md$/i.test(p) && !p.split('/').some((seg) => seg.startsWith('.')));
  }
  /** SKILL.md của một skill theo tên thư mục (…/<skillId>/SKILL.md). */
  const pathOf = (paths: string[], skillId: string) => paths.find((p) => p.toLowerCase().split('/').slice(-2, -1)[0] === skillId.toLowerCase());

  /** Tìm skill theo từ khoá trên skills.sh (chỉ gửi từ khoá). */
  async function search(query: string): Promise<{ ok: true; found: FoundSkill[] } | Fail> {
    const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (q.length < 2) return { ok: false, status: 400, error: 'Type at least 2 characters' };
    const body = await getText(`${SKILLS_SEARCH_URL}?q=${encodeURIComponent(q)}&limit=20`);
    if (body === null) return { ok: false, status: 502, error: 'Could not reach skills.sh' };
    let items: unknown[] = [];
    try { const v = (JSON.parse(body) as { skills?: unknown }).skills; if (Array.isArray(v)) items = v; } catch { /* không phải JSON */ }
    const found: FoundSkill[] = [];
    for (const it of items as Array<Record<string, unknown>>) {
      const source = String(it?.source ?? '');
      const skillId = String(it?.skillId ?? '');
      if (!REPO_RE.test(source) || !SKILL_ID_RE.test(skillId)) continue;
      const installs = Math.max(0, Math.floor(Number(it?.installs) || 0));
      found.push({ source, skillId, name: String(it?.name ?? skillId).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80), installs, trust: installs >= 1000 ? 'ok' : installs >= 100 ? 'caution' : 'risky' });
      if (found.length >= 20) break;
    }
    return { ok: true, found };
  }

  /** Nhập các skill đã chọn từ kết quả tìm: tải SKILL.md từ repo nguồn → khu chờ (cổng bảo mật). */
  async function importFound(items: Array<{ source: string; skillId: string }>): Promise<{ ok: true; added: Skill[]; failed: Array<{ path: string; error: string }> }> {
    const added: Skill[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    const trees = new Map<string, string[]>();
    for (const it of items.slice(0, 20)) {
      const label = `${it.source}@${it.skillId}`;
      if (!REPO_RE.test(it.source) || !SKILL_ID_RE.test(it.skillId)) { failed.push({ path: label, error: 'Invalid skill reference' }); continue; }
      const [owner, repo] = it.source.split('/') as [string, string];
      if (!trees.has(it.source)) trees.set(it.source, await skillPaths(owner, repo));
      const path = pathOf(trees.get(it.source)!, it.skillId);
      if (!path) { failed.push({ path: label, error: 'SKILL.md not found in the repository' }); continue; }
      const body = await getText(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}`);
      if (!body) { failed.push({ path: label, error: 'Could not download' }); continue; }
      const r = add(body, `https://github.com/${it.source} · ${path}`);
      if (r.ok) added.push(r.skill); else failed.push({ path: label, error: r.error });
    }
    return { ok: true, added, failed };
  }

  async function listGithub(url: string): Promise<{ ok: true; repo: string; candidates: GithubCandidate[] } | Fail> {
    const g = repoRef(url);
    if (!g) return { ok: false, status: 400, error: 'Not a GitHub repository link' };
    const all = await skillPaths(g.owner, g.repo);
    // "owner/repo@skill" → chỉ skill đó.
    const files = (g.skill ? [pathOf(all, g.skill)].filter((p): p is string => Boolean(p)) : all).slice(0, 30);
    if (!files.length) return { ok: false, status: 404, error: g.skill ? `Skill "${g.skill}" not found in that repository` : 'No SKILL.md found (private repo, wrong link, or no network)' };
    const candidates: GithubCandidate[] = [];
    for (const path of files) {
      const body = await getText(`https://raw.githubusercontent.com/${g.owner}/${g.repo}/HEAD/${path}`);
      if (!body) continue;
      const meta = parseSkillMd(body);
      candidates.push({ path, name: meta.name, description: meta.description, license: meta.license, chars: body.trim().length });
    }
    return { ok: true, repo: g.url, candidates };
  }

  async function importGithub(url: string, paths: string[]): Promise<{ ok: true; added: Skill[]; failed: Array<{ path: string; error: string }> } | Fail> {
    const g = repoRef(url);
    if (!g) return { ok: false, status: 400, error: 'Not a GitHub repository link' };
    const added: Skill[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const path of paths.slice(0, 30)) {
      if (!/(^|\/)SKILL\.md$/i.test(path) || path.includes('..')) { failed.push({ path, error: 'Not a SKILL.md path' }); continue; }
      const body = await getText(`https://raw.githubusercontent.com/${g.owner}/${g.repo}/HEAD/${path}`);
      if (!body) { failed.push({ path, error: 'Could not download' }); continue; }
      const r = add(body, `${g.url} · ${path}`);
      if (r.ok) added.push(r.skill); else failed.push({ path, error: r.error });
    }
    return { ok: true, added, failed };
  }

  /** Anh chỉnh ghế / project / bật tắt. Chỉ bật được skill đã qua cổng. */
  function update(id: number, p: { seats?: Seat[]; projects?: 'all' | string[]; on?: boolean }): { ok: true; skill: Skill } | Fail {
    const cur = readSkills(d.store).find((s) => s.id === id);
    if (!cur) return { ok: false, status: 404, error: 'Unknown skill' };
    if (p.on && cur.status !== 'approved') return { ok: false, status: 400, error: 'Only a skill that passed both security checks can be turned on' };
    const next: Skill = {
      ...cur,
      ...(p.seats ? { seats: SEATS.filter((s) => p.seats!.includes(s)) } : {}),
      ...(p.projects ? { projects: p.projects === 'all' ? 'all' : [...new Set(p.projects.map((k) => String(k).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean))].slice(0, 50) } : {}),
      ...(p.on !== undefined ? { on: p.on } : {}),
    };
    patch(id, () => next);
    return { ok: true, skill: next };
  }

  function remove(id: number): Skill[] {
    save(readSkills(d.store).filter((s) => s.id !== id));
    try { rmSync(skillFile(dataDir, id), { force: true }); } catch { /* đã xoá */ }
    return readSkills(d.store);
  }

  /** Kiểm lại từ đầu (vd sau khi Boss được bật): xoá kết quả cũ, tắt skill, về khu chờ. Core quét high thì vẫn bị từ chối. */
  function recheck(id: number): { ok: true } | Fail {
    const cur = readSkills(d.store).find((s) => s.id === id);
    if (!cur) return { ok: false, status: 404, error: 'Unknown skill' };
    const scan = staticScan(skillText(dataDir, id));
    const v = gateVerdict(scan, []);
    patch(id, (s) => ({ ...s, scan, reviews: [], on: false, status: v.status, note: v.note }));
    void tick();
    return { ok: true };
  }

  /** Hai người kiểm: (1) Boss nếu đang bật, (2) agent Claude khác Boss – ưu tiên ghế PM. Thiếu thì lấy agent khác; phải là 2 agent khác nhau. */
  function reviewers(): string[] {
    const agents = d.cfg.agents;
    const st = mbStatus(d.store);
    const boss = st.set && st.enabled ? Object.keys(agents).filter((a) => agents[a]!.provider === 'zai') : [];
    const seats = effectiveSeats(d.cfg, d.store) as Record<string, string>;
    const seated = SEATS.map((s) => seats[s]).filter((a): a is string => Boolean(a));
    const claude = [...new Set([...seated, ...Object.keys(agents)])].filter((a) => agents[a]?.tool === 'claude-code' && agents[a]?.provider !== 'zai');
    const others = [...new Set([...seated, ...Object.keys(agents)])].filter((a) => agents[a] && agents[a]!.tool !== 'antigravity-cli' && agents[a]!.provider !== 'zai');
    const first = boss[0] ?? others.find((a) => a !== claude[0]);
    const second = claude[0] ?? others.find((a) => a !== first);
    return [...new Set([first, second].filter((a): a is string => Boolean(a)))];
  }

  /** Lượt kiểm hỏng (lỗi / không đọc được kết quả): chưa tính là đã kiểm; thử lại ở lần tick sau, quá 3 lần thì từ chối. */
  function failed(id: number, agent: string): void {
    patch(id, (s) => {
      const tries = (s as Skill & { tries?: Record<string, number> }).tries ?? {};
      const n = (tries[agent] ?? 0) + 1;
      return n >= 3
        ? { ...s, status: 'rejected', note: `${nameOf(agent)} could not complete the security check (3 tries)` }
        : ({ ...s, note: `${nameOf(agent)}: check failed, will retry`, tries: { ...tries, [agent]: n } } as Skill);
    });
  }

  async function tick(): Promise<void> {
    if (inFlight) return;
    const project = d.store.getActiveProject();
    if (!project) return;
    if (!d.isolated && d.hostBusy()) return;
    const skill = readSkills(d.store).find((s) => s.status === 'checking');
    if (!skill) return;
    const who = reviewers();
    if (who.length < 2) { patch(skill.id, (s) => ({ ...s, note: 'Waiting: need two different reviewers (Boss + a Claude agent)' })); return; }
    const done = new Set(skill.reviews.map((r) => r.agent));
    const busy = new Set(d.store.openTurnAgents());
    const agent = who.find((a) => !done.has(a));
    if (!agent) { const v = gateVerdict(skill.scan, skill.reviews); patch(skill.id, (s) => ({ ...s, status: v.status, note: v.note })); return void tick(); }
    if (busy.has(agent)) return; // đang làm việc khác: chờ
    const gate = d.gate?.(agent);
    if (gate && !gate.ok) { patch(skill.id, (s) => ({ ...s, note: `Waiting for ${nameOf(agent)}: ${gate.reason}` })); return; }

    inFlight = true;
    const sid = d.store.createSession(['Skill check'], project);
    d.store.setSessionStatus(sid, 'running');
    const turnId = d.store.startTurn(sid, 'audit', agent, `SKILL-${skill.id}`);
    let ok = false;
    try {
      mkdirSync(d.logDir, { recursive: true });
      const logFile = join(d.logDir, `turn-${turnId}.log`);
      d.store.setTurnLog(turnId, logFile);
      const out = await d.runner('audit', agent, reviewPrompt(skill, skillText(dataDir, skill.id), nameOf(agent)), project, logFile, {
        account: usableAccounts(d.cfg, d.store, agent)[0]?.key,
        noImport: true,
      });
      const review = !out.timedOut && out.exitCode === 0 ? parseReview(`${out.output || ''}\n${out.lastMessage || ''}`) : null;
      ok = Boolean(review);
      d.store.endTurn(turnId, ok ? 'ok' : out.timedOut ? 'timeout' : out.exitCode !== 0 ? 'error' : 'rejected', ok ? undefined : out.timedOut ? 'timeout' : out.exitCode !== 0 ? `exit_${out.exitCode}` : 'review_invalid');
      if (review) {
        patch(skill.id, (s) => {
          const reviews = [...s.reviews.filter((r) => r.agent !== agent), { ...review, agent, at: new Date().toISOString() }];
          const v = gateVerdict(s.scan, reviews);
          return { ...s, reviews, status: v.status, note: v.note };
        });
      } else {
        failed(skill.id, agent);
      }
    } catch (err) {
      d.store.endTurn(turnId, 'error', err instanceof Error ? err.message : String(err));
      failed(skill.id, agent);
    } finally {
      d.store.setSessionStatus(sid, ok ? 'done' : 'error');
      inFlight = false;
      if (ok) void tick();
    }
  }

  return { add, search, importFound, listGithub, importGithub, update, remove, recheck, tick, running: () => inFlight, reviewers };
}

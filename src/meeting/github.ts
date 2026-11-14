// Tài liệu GitHub cho cuộc họp (anh Zon 2026-11-14): agent không có mạng → Core tải README + cây thư mục + file khai báo
// của repo CÔNG KHAI trong link anh dán. Chỉ gọi github.com; không gửi gì của project ra ngoài.
import { MATERIAL_MAX } from './core.ts';

const MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt'];
const TREE_MAX = 300;

export function parseGithubUrl(text: string): { owner: string; repo: string; url: string } | null {
  const m = /https?:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})/i.exec(String(text || ''));
  if (!m) return null;
  const repo = m[2]!.replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') return null;
  return { owner: m[1]!, repo, url: `https://github.com/${m[1]}/${repo}` };
}

async function getText(fetchFn: typeof fetch, url: string): Promise<string | null> {
  try {
    const res = await fetchFn(url, { headers: { 'User-Agent': 'btm-meeting', Accept: 'application/vnd.github+json, text/plain' }, signal: AbortSignal.timeout(10_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** README + cây thư mục + file khai báo, ≤ MATERIAL_MAX ký tự. Không tải được → { text: '', note }. */
export async function fetchGithubMaterial(text: string, fetchFn: typeof fetch = fetch): Promise<{ source: string; text: string; note: string } | null> {
  const g = parseGithubUrl(text);
  if (!g) return null;
  const raw = (p: string) => `https://raw.githubusercontent.com/${g.owner}/${g.repo}/HEAD/${p}`;
  const [treeJson, readme] = await Promise.all([
    getText(fetchFn, `https://api.github.com/repos/${g.owner}/${g.repo}/git/trees/HEAD?recursive=1`),
    getText(fetchFn, raw('README.md')),
  ]);
  let paths: string[] = [];
  try {
    const tree = (JSON.parse(treeJson ?? '{}') as { tree?: Array<{ path?: unknown; type?: unknown }> }).tree;
    if (Array.isArray(tree)) paths = tree.filter((t) => t.type === 'blob' && typeof t.path === 'string').map((t) => String(t.path));
  } catch { /* cây lỗi: bỏ qua */ }
  if (!readme && !paths.length) return { source: g.url, text: '', note: 'could not fetch (private repo, wrong link, or no network)' };

  const parts: string[] = [`Repo: ${g.url}`];
  if (readme) parts.push(`## README.md\n${readme.slice(0, 9000)}`);
  if (paths.length) parts.push(`## File tree (${paths.length} files${paths.length > TREE_MAX ? `, first ${TREE_MAX}` : ''})\n${paths.slice(0, TREE_MAX).join('\n')}`);
  for (const mf of MANIFESTS.filter((f) => paths.includes(f)).slice(0, 2)) {
    const body = await getText(fetchFn, raw(mf));
    if (body) parts.push(`## ${mf}\n${body.slice(0, 3000)}`);
  }
  const out = parts.join('\n\n');
  return { source: g.url, text: out.length > MATERIAL_MAX ? `${out.slice(0, MATERIAL_MAX - 1)}…` : out, note: `README ${readme ? 'ok' : 'missing'}, ${paths.length} files` };
}

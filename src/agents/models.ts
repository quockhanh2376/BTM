import { ModelSchema, type Tool } from '../config.ts';
import type { ProcResult } from '../runner/run.ts';

// Claude Code không có lệnh liệt kê model: alias + tên đầy đủ hiện hành.
// shortcut: danh sách cố định, cập nhật khi Anthropic ra model mới.
const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

export function parseAgyModels(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((l) => /^([A-Za-z0-9][A-Za-z0-9._:-]*)\t/.exec(l.replace(/\x1B\[[0-9;]*m/g, ''))?.[1])
    .filter((m): m is string => Boolean(m));
}

// `codex debug models` in JSON {"models":[{slug, visibility}]}; chỉ lấy model hiển thị cho người dùng.
export function parseCodexModels(out: string): string[] {
  const i = out.indexOf('{"models"');
  if (i < 0) return [];
  let depth = 0;
  let inStr = false;
  for (let j = i; j < out.length; j++) {
    const c = out[j];
    if (inStr) {
      if (c === '\\') j++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        const d = JSON.parse(out.slice(i, j + 1)) as { models?: Array<{ slug?: unknown; visibility?: unknown }> };
        return (d.models ?? []).filter((m) => m.visibility === 'list' && typeof m.slug === 'string').map((m) => m.slug as string);
      } catch {
        return [];
      }
    }
  }
  return [];
}

// Boss (provider zai): model GLM đã thử thật trên VM 2026-11-14. shortcut: danh sách cố định, thêm khi Z.ai ra model mới.
export const ZAI_MODELS = ['glm-5.3', 'glm-5.3-flash'];

export async function listModels(tool: Tool, run: (argv: string[]) => Promise<ProcResult>, provider?: 'zai'): Promise<string[]> {
  let models: string[] = [];
  if (provider === 'zai') models = ZAI_MODELS;
  else if (tool === 'claude-code') models = CLAUDE_MODELS;
  else if (tool === 'antigravity-cli') models = parseAgyModels((await run(['agy', 'models'])).output);
  else models = parseCodexModels((await run(['codex', 'debug', 'models'])).output);
  return [...new Set(models)].filter((m) => ModelSchema.safeParse(m).success);
}

import { describe, expect, it } from 'vitest';
import { listModels, parseAgyModels, parseCodexModels } from '../src/agents/models.ts';

describe('danh sách model theo CLI', () => {
  it('agy models: lấy cột id, bỏ dòng "Fetching…"', () => {
    const out = 'Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\r\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n';
    expect(parseAgyModels(out)).toEqual(['gemini-4-argon-medium', 'gemini-3.8-flash-high']);
  });
  it('codex debug models: chỉ model visibility=list, chịu được chữ trước/sau JSON và dấu } trong chuỗi', () => {
    const json = JSON.stringify({ models: [
      { slug: 'gpt-6.1-sol', visibility: 'list', description: 'a } b' },
      { slug: 'gpt-reserve', visibility: 'hide' },
      { slug: 'gpt-6-luna', visibility: 'list' },
    ] });
    expect(parseCodexModels(`warn\n${json}\ntrailer`)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(parseCodexModels('no json')).toEqual([]);
  });
  it('claude: danh sách cố định, không chạy lệnh; model lạ bị lọc', async () => {
    const run = async () => { throw new Error('không được gọi'); };
    expect(await listModels('claude-code', run as any)).toContain('opus');
    const bad = async () => ({ exitCode: 0, timedOut: false, durationMs: 0, output: '--evil\tx\nok-model\tOk\n' });
    expect(await listModels('antigravity-cli', bad)).toEqual(['ok-model']);
  });
});

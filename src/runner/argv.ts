import type { Effort, Seat, Tool } from '../config.ts';

export interface ArgvOpts {
  seat: Seat;
  timeoutMin: number;
  allow: string[];
  outFile: string;
  images?: string[];
  /** Không có → model mặc định của CLI. Đã kiểm ModelSchema (không cần quote thêm cho argv). */
  model?: string;
  effort?: Effort;
}

// Ghế chỉ đọc (Plan 8 Task 1): QC và Audit không được ghi file. agy chạy --mode plan (thử trên VM 2026-11-15: không ghi được file).
export const READ_ONLY_SEATS: ReadonlySet<Seat> = new Set<Seat>(['qc', 'audit']);

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildArgv(tool: Tool, prompt: string, o: ArgvOpts): string[] {
  switch (tool) {
    case 'antigravity-cli': {
      const readOnly = READ_ONLY_SEATS.has(o.seat);
      const json = JSON.stringify({
        permissions: {
          allow: readOnly ? [] : o.allow.map((cmd) => `command(${cmd})`),
        },
      });
      const modelArg = o.model ? ` --model ${shQuote(o.model)}` : '';
      // Model Gemini của agy mang sẵn mức effort trong tên (…-low/-medium/-high); gửi thêm --effort lệch thì agy từ chối.
      const effortArg = o.effort && !/-(low|medium|high)$/.test(o.model ?? '') ? ` --effort ${shQuote(o.effort)}` : '';
      const cmd = `agy -p ${shQuote(prompt)} --mode ${readOnly ? 'plan' : 'accept-edits'} --sandbox --settings ${shQuote(json)} --print-timeout ${o.timeoutMin}m${modelArg}${effortArg}`;
      return ['script', '-qec', cmd, '/dev/null'];
    }
    case 'codex-cli': {
      const imageArgs = o.images && o.images.length > 0 ? o.images.flatMap((img) => ['-i', img]) : [];
      const codexEffort = o.effort;
      return [
        'codex',
        'exec',
        ...(o.model ? ['-m', o.model] : []),
        ...(codexEffort ? ['-c', `model_reasoning_effort="${codexEffort}"`] : []),
        '--sandbox',
        READ_ONLY_SEATS.has(o.seat) ? 'read-only' : 'workspace-write',
        '-o',
        o.outFile,
        ...imageArgs,
        '--',
        prompt,
      ];
    }
    case 'claude-code': {
      const flags = [...(o.model ? ['--model', o.model] : []), ...(o.effort ? ['--effort', o.effort] : [])];
      if (READ_ONLY_SEATS.has(o.seat)) {
        return ['claude', ...flags, '-p', prompt, '--allowedTools', 'Read,Grep,Glob'];
      }
      return [
        'claude',
        ...flags,
        '-p',
        prompt,
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        o.allow.map((c) => `Bash(${c}:*)`).join(','),
        'Read',
        'Edit',
        'Write',
      ];
    }
    default: {
      const _exhaustive: never = tool;
      throw new Error(`Unsupported tool: ${_exhaustive}`);
    }
  }
}

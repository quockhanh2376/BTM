import type { Seat, Tool } from '../config.ts';

export interface ArgvOpts {
  seat: Seat;
  timeoutMin: number;
  allow: string[];
  outFile: string;
  images?: string[];
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildArgv(tool: Tool, prompt: string, o: ArgvOpts): string[] {
  switch (tool) {
    case 'antigravity-cli': {
      const json = JSON.stringify({
        permissions: {
          allow: o.allow.map((cmd) => `command(${cmd})`),
        },
      });
      const cmd = `agy -p ${shQuote(prompt)} --mode accept-edits --sandbox --settings ${shQuote(json)} --print-timeout ${o.timeoutMin}m`;
      return ['script', '-qec', cmd, '/dev/null'];
    }
    case 'codex-cli': {
      const imageArgs = o.images && o.images.length > 0 ? o.images.flatMap((img) => ['-i', img]) : [];
      return [
        'codex',
        'exec',
        '--sandbox',
        o.seat === 'qc' ? 'read-only' : 'workspace-write',
        '-o',
        o.outFile,
        ...imageArgs,
        prompt,
      ];
    }
    case 'claude-code': {
      if (o.seat === 'qc') {
        return ['claude', '-p', prompt, '--allowedTools', 'Read'];
      }
      return [
        'claude',
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

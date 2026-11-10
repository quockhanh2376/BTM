import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, commitAll } from '../git.ts';
import type { Config } from '../config.ts';
import { ensureTrustedRepo } from '../isolation/trusted.ts';

export type RunOpenspecFn = (
  args: string[],
  options: { cwd: string; timeout?: number }
) => void | { ok?: boolean; error?: string };

export interface InitProjectOptions {
  key: string;
  cfg?: Config;
  runOpenspec?: RunOpenspecFn;
}

function defaultRunOpenspec(
  args: string[],
  options: { cwd: string; timeout?: number }
): void {
  const result = spawnSync('openspec', args, {
    cwd: options.cwd,
    timeout: options.timeout ?? 60_000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const errorMsg = (result.stderr || result.stdout || '').trim();
    throw new Error(`openspec exited with code ${result.status}${errorMsg ? `: ${errorMsg}` : ''}`);
  }
}

export function initProject(
  projectsRoot: string,
  name: string,
  templatesFrom: string,
  opts: InitProjectOptions
): string {
  if (!opts || !opts.key || typeof opts.key !== 'string' || !/^[A-Z]{2,5}$/.test(opts.key)) {
    throw new Error(`Invalid project key "${opts?.key}". Project key must match /^[A-Z]{2,5}$/`);
  }

  const runOpenspec = opts.runOpenspec ?? defaultRunOpenspec;
  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`Invalid project name "${name}". Project name must match /^[a-z0-9-]+$/`);
  }

  const projectPath = join(projectsRoot, name);
  if (existsSync(projectPath)) {
    throw new Error(`Project directory already exists: "${projectPath}"`);
  }

  // Kiểm tra template tồn tại TRƯỚC khi tạo thư mục
  let templateFile = templatesFrom;
  if (existsSync(join(templatesFrom, 'team', 'templates', 'report.md'))) {
    templateFile = join(templatesFrom, 'team', 'templates', 'report.md');
  } else if (existsSync(join(templatesFrom, 'report.md'))) {
    templateFile = join(templatesFrom, 'report.md');
  }

  let templateValid = false;
  try {
    if (existsSync(templateFile) && statSync(templateFile).isFile()) {
      templateValid = true;
    }
  } catch {
    templateValid = false;
  }

  if (!templateValid) {
    throw new Error(`Template file not found from "${templatesFrom}"`);
  }

  const templateContent = readFileSync(templateFile, 'utf8');

  // Tạo cây thư mục dự án; nếu lỗi giữa chừng thì xóa thư mục vừa tạo
  let created = false;
  try {
    mkdirSync(projectPath, { recursive: true });
    created = true;

    mkdirSync(join(projectPath, 'team', 'tickets'), { recursive: true });
    mkdirSync(join(projectPath, 'team', 'goals'), { recursive: true });
    mkdirSync(join(projectPath, 'team', 'prompts'), { recursive: true });
    mkdirSync(join(projectPath, 'team', 'reports'), { recursive: true });
    mkdirSync(join(projectPath, 'team', 'templates'), { recursive: true });
    mkdirSync(join(projectPath, 'team', 'memory'), { recursive: true });
    mkdirSync(join(projectPath, 'docs'), { recursive: true });

    // Ghi team/project.yaml
    writeFileSync(join(projectPath, 'team', 'project.yaml'), `key: ${opts.key}\n`, 'utf8');

    // Chép team/templates/report.md từ repo BTM
    writeFileSync(join(projectPath, 'team', 'templates', 'report.md'), templateContent, 'utf8');

    // Tạo .gitignore
    const gitignoreContent = [
      'node_modules/',
      'dist/',
      '*.db',
      '*.db-*',
      '.env',
      '.superpowers/',
      '',
    ].join('\n');
    writeFileSync(join(projectPath, '.gitignore'), gitignoreContent, 'utf8');

    // git init -b main và commit "init"
    git(projectPath, 'init', '-b', 'main');

    // Chạy openspec init (sau git init, trước commit "init")
    const openspecArgs = [
      'init',
      '--tools',
      'claude,codex,antigravity',
      '--language',
      'vi',
      '--no-animation',
    ];
    try {
      const res = runOpenspec(openspecArgs, { cwd: projectPath, timeout: 60_000 });
      if (res && typeof res === 'object' && res.ok === false) {
        const errorMsg = res.error || 'Khởi tạo openspec thất bại';
        const warningContent = `# Cảnh báo: OpenSpec không thể khởi tạo\n\n${errorMsg}\n`;
        writeFileSync(join(projectPath, 'docs', 'README-btm.md'), warningContent, 'utf8');
      }
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      const warningContent = `# Cảnh báo: OpenSpec không thể khởi tạo\n\n${errorMsg}\n`;
      writeFileSync(join(projectPath, 'docs', 'README-btm.md'), warningContent, 'utf8');
    }

    commitAll(projectPath, 'init', { name: 'btm', email: 'btm@btm.local' });
    if (opts.cfg?.host.worker_user) ensureTrustedRepo(opts.cfg, projectPath);

    return projectPath;
  } catch (err) {
    if (created && existsSync(projectPath)) {
      try {
        rmSync(projectPath, { recursive: true, force: true });
      } catch {
        // ignore rm error
      }
    }
    throw err;
  }
}

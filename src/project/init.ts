import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, commitAll } from '../git.ts';

export function initProject(projectsRoot: string, name: string, templatesFrom: string): string {
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

    mkdirSync(join(projectPath, 'team', 'tasks'), { recursive: true });
    mkdirSync(join(projectPath, 'team', 'prompts'), { recursive: true });
    mkdirSync(join(projectPath, 'team', 'reports'), { recursive: true });
    mkdirSync(join(projectPath, 'team', 'templates'), { recursive: true });
    mkdirSync(join(projectPath, 'team', 'memory'), { recursive: true });
    mkdirSync(join(projectPath, 'docs'), { recursive: true });

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
    commitAll(projectPath, 'init', { name: 'btm', email: 'btm@btm.local' });

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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export function slugify(title: string): string {
  if (!title) {
    return 'goal';
  }

  const normalized = title
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const truncated = normalized.slice(0, 30).replace(/-+$/, '');
  return truncated || 'goal';
}

export function goalBranch(n: number, title: string): string {
  return `goal/G${n}-${slugify(title)}`;
}

export function readProjectKey(repo: string): string {
  const projectYamlPath = join(repo, 'team', 'project.yaml');
  if (!existsSync(projectYamlPath)) {
    throw new Error(`Project configuration file not found: "${projectYamlPath}"`);
  }

  let content: string;
  try {
    content = readFileSync(projectYamlPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read project configuration "${projectYamlPath}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    throw new Error(`Invalid YAML in "${projectYamlPath}": ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid project configuration in "${projectYamlPath}": expected an object`);
  }

  const key = (parsed as { key?: unknown }).key;
  if (typeof key !== 'string' || !/^[A-Z]{2,5}$/.test(key)) {
    throw new Error(
      `Invalid or missing project key in "${projectYamlPath}". Expected key matching /^[A-Z]{2,5}$/, got "${key}"`
    );
  }

  return key;
}


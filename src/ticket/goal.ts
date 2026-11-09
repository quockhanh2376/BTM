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

// Energy của Boss (gói Z.ai GLM Coding Max: giới hạn 5 giờ + tuần). Core gọi endpoint giám sát của Z.ai bằng key
// trong kho (agent không thấy key). shortcut: endpoint không chính thức (công cụ cộng đồng đều dùng) – đổi dạng thì trả
// [] và dashboard hiện "Z.ai" như trước; nâng cấp khi Z.ai có API chính thức.
import type { EnergyWindow } from '../energy/quota.ts';

export const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

interface Limit { type?: unknown; percentage?: unknown; nextResetTime?: unknown }

/** TOKENS_LIMIT thứ nhất = cửa sổ 5 giờ, thứ hai = tuần; percentage là phần đã dùng. */
export function parseZaiQuota(body: unknown, now = Date.now()): EnergyWindow[] {
  const limits = (body as { data?: { limits?: Limit[] } })?.data?.limits;
  if (!Array.isArray(limits)) return [];
  const tokens = limits.filter((l) => l && l.type === 'TOKENS_LIMIT');
  const out: EnergyWindow[] = [];
  (['5h', 'week'] as const).forEach((name, i) => {
    const l = tokens[i];
    const used = Number(l?.percentage);
    if (!l || !Number.isFinite(used)) return;
    const reset = Number(l.nextResetTime);
    const fallback = now + (name === '5h' ? 5 * 3600_000 : 7 * 86400_000);
    out.push({
      name,
      remainingPercent: Math.max(0, Math.min(100, Math.round(100 - used))),
      resetsAt: new Date(Number.isFinite(reset) && reset > 0 ? reset : fallback).toISOString(),
    });
  });
  return out;
}

export async function fetchZaiQuota(key: string, fetchFn: typeof fetch = fetch): Promise<EnergyWindow[]> {
  try {
    const res = await fetchFn(ZAI_QUOTA_URL, {
      // Endpoint này nhận key thô, không có "Bearer " (Bearer → 401).
      headers: { Authorization: key, 'Accept-Language': 'en-US,en', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    return parseZaiQuota(await res.json());
  } catch {
    return [];
  }
}

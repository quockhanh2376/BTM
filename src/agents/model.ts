import { EffortSchema, ModelSchema, type Config, type Effort } from '../config.ts';

type Settings = { getSetting(key: string): string | null } | null | undefined;

export const agentModelKey = (id: string) => `agent_model:${id}`;
export const agentEffortKey = (id: string) => `agent_effort:${id}`;

// Dashboard (setting) ghi đè config; giá trị setting không hợp lệ → bỏ qua. Chuỗi rỗng ở setting = dùng mặc định CLI.
export function agentModel(cfg: Config, settings: Settings, id: string): string | undefined {
  const v = settings?.getSetting(agentModelKey(id));
  if (v !== null && v !== undefined) {
    if (v === '') return undefined;
    if (ModelSchema.safeParse(v).success) return v;
  }
  return cfg.agents[id]?.model;
}

export function agentEffort(cfg: Config, settings: Settings, id: string): Effort {
  const v = settings?.getSetting(agentEffortKey(id));
  const parsed = EffortSchema.safeParse(v);
  if (parsed.success) return parsed.data;
  return cfg.agents[id]?.effort ?? 'medium';
}

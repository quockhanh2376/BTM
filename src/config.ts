import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { isAbsolute } from 'node:path';

export type Seat = 'pm' | 'dev' | 'qc' | 'audit';
export const SeatSchema = z.enum(['pm', 'dev', 'qc', 'audit']);

export type Tool = 'claude-code' | 'antigravity-cli' | 'codex-cli';
export const ToolSchema = z.enum(['claude-code', 'antigravity-cli', 'codex-cli']);

export const HostSchema = z.object({
  run_as_user: z.string(),
  projects_root: z.string(),
  dashboard: z.object({
    bind: z.literal('127.0.0.1'),
    port: z.number().int(),
  }).strict(),
  data_dir: z.string(),
  // Cách ly: user Linux của agent = <worker_prefix><agentId> (vd btm-elon); workspace ở <work_root>/<user>/<project>.
  worker_prefix: z.string().regex(/^[a-z_][a-z0-9_-]{0,15}$/).optional(),
  trusted_root: z.string().refine(isAbsolute, 'trusted_root must be an absolute path').optional(),
  work_root: z.string().refine(isAbsolute, 'work_root must be an absolute path').optional(),
  ssh_hint: z.string().default('admzon@100.96.250.103'),
}).strict();

export const SessionSchema = z.object({
  max_goals: z.number().int().positive(),
  max_turns: z.number().int().positive(),
  max_turns_per_seat: z.object({
    pm: z.number().int().nonnegative(),
    dev: z.number().int().nonnegative(),
    qc: z.number().int().nonnegative(),
    audit: z.number().int().nonnegative().default(4),
  }).strict(),
  require_task_approval: z.boolean(),
  auto_schedule: z.literal(false),
}).strict();

export const TurnSchema = z.object({
  timeout_minutes: z.object({
    pm: z.number().positive(),
    dev: z.number().positive(),
    qc: z.number().positive(),
    audit: z.number().positive().default(20),
  }).strict(),
  max_parallel_agents: z.literal(1),
  commit_before_dev_turn: z.boolean(),
  max_fix_rounds: z.number().int().nonnegative(),
  /** Plan 6 Task 6: dừng lượt khi CLI không in gì N phút. Chỉ đặt cho công cụ có in tiến độ (agy, codex);
   *  claude -p chỉ in khi xong nên để trống. Mặc định tắt. */
  idle_minutes: z.object({
    'claude-code': z.number().positive().optional(),
    'antigravity-cli': z.number().positive().optional(),
    'codex-cli': z.number().positive().optional(),
  }).strict().optional(),
}).strict();

export const SeatsSchema = z.object({
  pm: z.string(),
  dev: z.string(),
  qc: z.string(),
  audit: z.string().default(''),
}).strict();

export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof EffortSchema>;
// Model đi thẳng vào argv của CLI: chỉ chữ/số và . _ : -
export const ModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/);

export const AgentConfigSchema = z.object({
  tool: ToolSchema,
  command: z.string(),
  needs_pty: z.boolean().optional(),
  can_sit: z.array(SeatSchema).nonempty(),
  /** Không đặt → model mặc định của CLI (không truyền cờ model). */
  model: ModelSchema.optional(),
  /** Không đặt → medium (agentEffort). */
  effort: EffortSchema.optional(),
}).strict();

export const RulesSchema = z.object({
  coder_cannot_qc_same_task: z.boolean(),
  auto_handoff_on_failure: z.boolean(),
  // Plan 7: true = hết quota thì đổi sang tài khoản kế tiếp của cùng Worker; false = chỉ tài khoản đầu tiên đang bật.
  auto_switch_accounts: z.boolean().default(true),
}).strict();

export const EnergySchema = z.object({
  read_on: z.array(z.string()),
  cache_seconds: z.number().int().nonnegative(),
  min_remaining_percent: z.number().min(0).max(100),
  reserve_turns_for_pm: z.number().int().nonnegative(),
  /** Plan 6 Task 5: chip "Sắp hết" khi cửa sổ thấp nhất còn ≤ mức này. */
  warn_percent: z.number().min(0).max(100).optional(),
}).strict();

export const LoginSchema = z.object({
  check_on: z.array(z.string()),
  warn_expiry_days: z.number().int().nonnegative(),
  forbidden_env: z.array(z.string()),
}).strict();

export const GateSchema = z.object({
  require_report_schema: z.boolean(),
  require_commit: z.boolean(),
  reject_empty_diff: z.boolean(),
  enforce_task_scope: z.boolean(),
  commands: z.object({
    build: z.string(),
    lint: z.string(),
    test: z.string(),
  }).strict(),
}).strict();

export const GitSchema = z.object({
  protected_branch: z.string(),
  task_branch_prefix: z.string(),
  merge_by: z.string(),
}).strict();

export const PluginsSchema = z.object({
  project: z.array(z.string()),
  per_seat: z.object({
    pm: z.array(z.string()),
    dev: z.array(z.string()),
    qc: z.array(z.string()),
    audit: z.array(z.string()).default([]),
  }).strict(),
  later: z.array(z.string()).optional(),
}).strict();

export const RunnerSchema = z.object({
  agy_allow_commands: z.array(z.string()),
}).strict();

const BaseConfigSchema = z.object({
  host: HostSchema,
  session: SessionSchema,
  turn: TurnSchema,
  seats: SeatsSchema,
  agents: z.record(z.string(), AgentConfigSchema),
  /** Plan 5 Task 7: người ngồi thay khi người chính hết Energy/đăng nhập, theo thứ tự. */
  seats_backup: z.object({
    pm: z.array(z.string()).optional(),
    dev: z.array(z.string()).optional(),
    qc: z.array(z.string()).optional(),
    audit: z.array(z.string()).optional(),
  }).strict().optional(),
  /** Plan 6 Task 1: thông báo ntfy. url_file chứa URL topic (https), ngoài git, 0600. */
  notify: z.object({
    url_file: z.string().refine(isAbsolute, 'notify.url_file must be an absolute path'),
    dashboard_url: z.string().regex(/^https?:\/\/[^\s]+$/).optional(),
    on: z.array(z.enum(['needs_owner', 'awaiting_approval', 'done', 'stopped', 'out_of_turns']))
      .default(['needs_owner', 'awaiting_approval', 'out_of_turns']),
  }).strict().optional(),
  /** Decision 0006: vòng release. Mặc định tắt hết (giữ hành vi cũ). */
  release: z.object({
    // Không có ghế audit thì dừng (needs_owner) thay vì bỏ qua audit.
    require_audit: z.boolean().default(false),
    // PM luôn thêm ticket cuối viết README/CHANGELOG/version.
    docs_ticket: z.boolean().default(false),
    // project key -> "owner/repo" trên GitHub; core push main + tag bằng deploy key <data_dir>/keys/<KEY>.
    github: z.record(z.string().regex(/^[A-Z]{2,5}$/), z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).default({}),
  }).strict().optional(),
  rules: RulesSchema,
  energy: EnergySchema,
  login: LoginSchema,
  gate: GateSchema,
  git: GitSchema,
  plugins: PluginsSchema,
  runner: RunnerSchema,
}).strict();

export const ConfigSchema = BaseConfigSchema.superRefine((cfg, ctx) => {
  for (const [seat, ids] of Object.entries(cfg.seats_backup ?? {}) as [Seat, string[] | undefined][]) {
    for (const id of ids ?? []) {
      const agent = Object.hasOwn(cfg.agents, id) ? cfg.agents[id] : undefined;
      if (!agent || !agent.can_sit.includes(seat)) {
        ctx.addIssue({ code: 'custom', message: `seats_backup.${seat}: agent '${id}' unknown or not allowed in this seat`, path: ['seats_backup', seat] });
      }
    }
  }
  // Plan 8 Task 1: agy không có chế độ chỉ đọc → không được ngồi ghế QC/Audit.
  for (const [id, agent] of Object.entries(cfg.agents)) {
    if (agent.tool !== 'antigravity-cli') continue;
    for (const seat of agent.can_sit) {
      if (seat === 'qc' || seat === 'audit') {
        ctx.addIssue({ code: 'custom', message: `Agent '${id}': agy has no read-only mode; it cannot sit in ${seat}`, path: ['agents', id, 'can_sit'] });
      }
    }
  }
  // Cách ly: agent id thành tên user Linux <worker_prefix><id>.
  if (cfg.host.worker_prefix) {
    for (const id of Object.keys(cfg.agents)) {
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(`${cfg.host.worker_prefix}${id}`)) {
        ctx.addIssue({ code: 'custom', message: `Agent id '${id}' is not a valid Linux user name suffix`, path: ['agents', id] });
      }
    }
  }
  const seatKeys: Seat[] = ['pm', 'dev', 'qc'];
  if (cfg.seats.audit) {
    seatKeys.push('audit');
  }
  for (const seat of seatKeys) {
    const agentId = cfg.seats[seat];
    if (!agentId) continue;
    const agent = Object.hasOwn(cfg.agents, agentId) ? cfg.agents[agentId] : undefined;
    if (!agent) {
      ctx.addIssue({
        code: 'custom',
        message: `Seat '${seat}' points to unknown agent '${agentId}'`,
        path: ['seats', seat],
      });
    } else if (!agent.can_sit.includes(seat)) {
      ctx.addIssue({
        code: 'custom',
        message: `Agent '${agentId}' cannot sit in seat '${seat}' (can_sit: ${agent.can_sit.join(', ')})`,
        path: ['seats', seat],
      });
    }
  }
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(path: string): Config {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config file "${path}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    throw new ConfigError(`Invalid YAML in "${path}": ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const p = issue.path.join('.');
        return p ? `${p}: ${issue.message}` : issue.message;
      })
      .join('; ');
    throw new ConfigError(`Config validation error in "${path}": ${details}`);
  }

  return result.data;
}

export function checkForbiddenEnv(env: NodeJS.ProcessEnv, names: string[]): string[] {
  const violations: string[] = [];
  for (const name of names) {
    if (name in env && env[name] !== undefined) {
      violations.push(name);
    }
  }
  return violations;
}

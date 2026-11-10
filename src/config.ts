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
  worker_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional(),
  trusted_root: z.string().refine(isAbsolute, 'trusted_root must be an absolute path').optional(),
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
}).strict();

export const SeatsSchema = z.object({
  pm: z.string(),
  dev: z.string(),
  qc: z.string(),
  audit: z.string().default(''),
}).strict();

export const AgentConfigSchema = z.object({
  tool: ToolSchema,
  command: z.string(),
  needs_pty: z.boolean().optional(),
  can_sit: z.array(SeatSchema).nonempty(),
}).strict();

export const RulesSchema = z.object({
  coder_cannot_qc_same_task: z.boolean(),
  auto_handoff_on_failure: z.boolean(),
  auto_switch_accounts: z.literal(false),
}).strict();

export const EnergySchema = z.object({
  read_on: z.array(z.string()),
  cache_seconds: z.number().int().nonnegative(),
  min_remaining_percent: z.number().min(0).max(100),
  reserve_turns_for_pm: z.number().int().nonnegative(),
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
  rules: RulesSchema,
  energy: EnergySchema,
  login: LoginSchema,
  gate: GateSchema,
  git: GitSchema,
  plugins: PluginsSchema,
  runner: RunnerSchema,
}).strict();

export const ConfigSchema = BaseConfigSchema.superRefine((cfg, ctx) => {
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadConfig, ConfigError, checkForbiddenEnv } from '../src/config.ts';

describe('Config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'btm-config-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTestConfig(modifier?: (raw: any) => void): string {
    const originalYaml = readFileSync('btm.config.yaml', 'utf8');
    const parsed = parseYaml(originalYaml);
    if (modifier) {
      modifier(parsed);
    }
    const targetPath = join(tmpDir, 'btm.config.yaml');
    writeFileSync(targetPath, stringifyYaml(parsed), 'utf8');
    return targetPath;
  }

  it('loads repo config', () => {
    const config = loadConfig('btm.config.yaml');
    expect(config.seats).toEqual({
      pm: 'elon',
      dev: 'jacky',
      qc: 'jenny',
      audit: '',
    });
    expect(config.runner.agy_allow_commands).toContain('npx vitest');
  });

  it('P5-T1: agent có model + effort; mặc định effort medium; model/effort lạ hoặc id không hợp user Linux → lỗi', () => {
    const ok = loadConfig(writeTestConfig((raw) => {
      raw.agents.kai = { tool: 'antigravity-cli', command: 'agy', can_sit: ['audit'], model: 'gemini-3.8-flash-high' };
    }));
    expect(ok.agents.kai.model).toBe('gemini-3.8-flash-high');
    expect(ok.agents.kai.effort).toBeUndefined(); // mặc định medium ở agentEffort (Task 2)
    expect(ok.agents.elon.model).toBeUndefined();
    expect(() => loadConfig(writeTestConfig((raw) => { raw.agents.elon.model = 'a;rm -rf /'; }))).toThrow(ConfigError);
    expect(() => loadConfig(writeTestConfig((raw) => { raw.agents.elon.model = '--dangerous'; }))).toThrow(ConfigError);
    expect(() => loadConfig(writeTestConfig((raw) => { raw.agents.elon.effort = 'ultra'; }))).toThrow(ConfigError);
    expect(() => loadConfig(writeTestConfig((raw) => {
      raw.host.worker_prefix = 'btm-';
      raw.agents['Kai!'] = { tool: 'codex-cli', command: 'codex', can_sit: ['qc'] };
    }))).toThrow(ConfigError);
  });

  it('rejects auto_schedule true', () => {
    const configFile = writeTestConfig((raw) => {
      raw.session.auto_schedule = true;
    });
    expect(() => loadConfig(configFile)).toThrow(ConfigError);
  });

  it('loads config with audit seat when agent can sit in audit', () => {
    const configFile = writeTestConfig((raw) => {
      raw.agents.kai = {
        tool: 'antigravity-cli',
        command: 'agy',
        can_sit: ['audit'],
      };
      raw.seats.audit = 'kai';
    });
    const config = loadConfig(configFile);
    expect(config.seats.audit).toBe('kai');
  });

  it('rejects audit seat pointing to agent that cannot sit in audit', () => {
    const configFile = writeTestConfig((raw) => {
      raw.seats.audit = 'jacky'; // jacky only has can_sit: [dev]
    });
    expect(() => loadConfig(configFile)).toThrow(ConfigError);
  });

  it('rejects audit seat pointing to non-existent agent', () => {
    const configFile = writeTestConfig((raw) => {
      raw.seats.audit = 'non-existent-agent';
    });
    expect(() => loadConfig(configFile)).toThrow(ConfigError);
  });

  it('rejects seat pointing to agent that cannot sit', () => {
    const configFile = writeTestConfig((raw) => {
      raw.seats.pm = 'jacky'; // jacky only has can_sit: [dev]
    });
    expect(() => loadConfig(configFile)).toThrow(ConfigError);
  });

  it('rejects missing key', () => {
    const configFile = writeTestConfig((raw) => {
      delete raw.turn;
    });
    expect(() => loadConfig(configFile)).toThrow(ConfigError);
    try {
      loadConfig(configFile);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain('turn');
    }
  });

  it('rejects seat pointing to non-existent agent', () => {
    const configFile = writeTestConfig((raw) => {
      raw.seats.pm = 'unknown-agent';
    });
    expect(() => loadConfig(configFile)).toThrow(ConfigError);
  });

  it('rejects seat pointing to inherited property name like toString with ConfigError', () => {
    const configFile = writeTestConfig((raw) => {
      raw.seats.pm = 'toString';
    });
    expect(() => loadConfig(configFile)).toThrow(ConfigError);
  });

  it('rejects max_parallel_agents not equal to 1', () => {
    const configFile = writeTestConfig((raw) => {
      raw.turn.max_parallel_agents = 2;
    });
    expect(() => loadConfig(configFile)).toThrow(ConfigError);
  });

  it('rejects unknown key at root level', () => {
    const configFile = writeTestConfig((raw) => {
      raw.unknown_root_key = 'unexpected';
    });
    expect(() => loadConfig(configFile)).toThrow(ConfigError);
  });

  it('rejects unknown key in nested section', () => {
    const configFile = writeTestConfig((raw) => {
      raw.host.unknown_nested_key = 'unexpected';
    });
    expect(() => loadConfig(configFile)).toThrow(ConfigError);
  });

  it('auto_switch_accounts (Plan 7): boolean, default true; non-boolean rejected', () => {
    expect(loadConfig(writeTestConfig((raw) => { raw.rules.auto_switch_accounts = false; })).rules.auto_switch_accounts).toBe(false);
    expect(loadConfig(writeTestConfig((raw) => { delete raw.rules.auto_switch_accounts; })).rules.auto_switch_accounts).toBe(true);
    expect(() => loadConfig(writeTestConfig((raw) => { raw.rules.auto_switch_accounts = 'yes'; }))).toThrow(ConfigError);
  });

  it('rejects non-existent config file', () => {
    expect(() => loadConfig(join(tmpDir, 'does-not-exist.yaml'))).toThrow(ConfigError);
  });

  it('rejects invalid YAML syntax', () => {
    const badFile = join(tmpDir, 'invalid.yaml');
    writeFileSync(badFile, ': invalid: yaml: [', 'utf8');
    expect(() => loadConfig(badFile)).toThrow(ConfigError);
  });

  it('rejects host.dashboard.bind not equal to 127.0.0.1 (e.g. 0.0.0.0) with ConfigError', () => {
    const configFile = writeTestConfig((raw) => {
      raw.host.dashboard.bind = '0.0.0.0';
    });
    expect(() => loadConfig(configFile)).toThrow(ConfigError);
  });

  it('defaults host.ssh_hint to admzon@100.96.250.103 and accepts custom ssh_hint', () => {
    const config = loadConfig('btm.config.yaml');
    expect(config.host.ssh_hint).toBe('admzon@100.96.250.103');

    const customFile = writeTestConfig((raw) => {
      raw.host.ssh_hint = 'custom-user@custom-host';
    });
    const customConfig = loadConfig(customFile);
    expect(customConfig.host.ssh_hint).toBe('custom-user@custom-host');
  });
});

describe('checkForbiddenEnv', () => {
  it('detects forbidden env vars and ignores allowed vars', () => {
    const env = { ANTHROPIC_API_KEY: 'x', PATH: '/bin' };
    const forbidden = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
    expect(checkForbiddenEnv(env, forbidden)).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('treats empty string env var as a violation', () => {
    const env = { ANTHROPIC_API_KEY: '', PATH: '/bin' };
    const forbidden = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
    expect(checkForbiddenEnv(env, forbidden)).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('returns empty array when no forbidden env vars are present', () => {
    const env = { PATH: '/usr/bin', HOME: '/home/agent' };
    const forbidden = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
    expect(checkForbiddenEnv(env, forbidden)).toEqual([]);
  });
});

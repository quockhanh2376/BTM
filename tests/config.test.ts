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
    });
    expect(config.runner.agy_allow_commands).toContain('npx vitest');
  });

  it('rejects auto_schedule true', () => {
    const configFile = writeTestConfig((raw) => {
      raw.session.auto_schedule = true;
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

  it('rejects auto_switch_accounts true', () => {
    const configFile = writeTestConfig((raw) => {
      raw.rules.auto_switch_accounts = true;
    });
    expect(() => loadConfig(configFile)).toThrow(ConfigError);
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

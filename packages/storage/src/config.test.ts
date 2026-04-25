import { describe, it, expect } from 'vitest';
import { loadPgConfig, buildPoolConfigFromFile, __internal } from './config.js';

const PASSWORD_FIXTURE = 'super-secret-password-do-not-leak';

function fakeFileContents(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    postgres: {
      host: '127.0.0.1',
      port: 5432,
      username: 'postgres',
      password: PASSWORD_FIXTURE,
      ssl_mode: 'disable',
      databases: { main: 'pulse5', test: 'pulse5_test' },
      ...overrides,
    },
  });
}

describe('loadPgConfig', () => {
  it('prefers DATABASE_URL when set', () => {
    const cfg = loadPgConfig({
      env: { DATABASE_URL: `postgres://u:${PASSWORD_FIXTURE}@h:5432/d` } as NodeJS.ProcessEnv,
      readFile: () => {
        throw new Error('readFile should not be called when DATABASE_URL is set');
      },
    });
    expect(cfg.source).toBe('DATABASE_URL');
    expect(cfg.poolConfig.connectionString).toBe(
      `postgres://u:${PASSWORD_FIXTURE}@h:5432/d`
    );
    expect(cfg.redactedDsn).toBe('postgres://u:***@h:5432/d');
    expect(cfg.redactedDsn).not.toContain(PASSWORD_FIXTURE);
  });

  it('falls back to JSON file when DATABASE_URL is unset', () => {
    const cfg = loadPgConfig({
      env: {} as NodeJS.ProcessEnv,
      readFile: () => fakeFileContents(),
    });
    expect(cfg.source).toBe('json-file');
    expect(cfg.poolConfig.host).toBe('127.0.0.1');
    expect(cfg.poolConfig.port).toBe(5432);
    expect(cfg.poolConfig.user).toBe('postgres');
    expect(cfg.poolConfig.database).toBe('pulse5');
    expect(cfg.poolConfig.password).toBe(PASSWORD_FIXTURE);
    expect(cfg.redactedDsn).toBe('postgres://postgres:***@127.0.0.1:5432/pulse5');
    expect(cfg.redactedDsn).not.toContain(PASSWORD_FIXTURE);
  });

  it('uses PULSE5_DB_TARGET to select test database', () => {
    const cfg = loadPgConfig({
      env: { PULSE5_DB_TARGET: 'test' } as NodeJS.ProcessEnv,
      readFile: () => fakeFileContents(),
    });
    expect(cfg.poolConfig.database).toBe('pulse5_test');
  });

  it('accepts a literal db name as target when not a known key', () => {
    const cfg = loadPgConfig({
      env: { PULSE5_DB_TARGET: 'pulse5_dev' } as NodeJS.ProcessEnv,
      readFile: () => fakeFileContents(),
    });
    expect(cfg.poolConfig.database).toBe('pulse5_dev');
  });

  it('reads a custom path from PULSE5_PG_CONFIG_PATH', () => {
    let observedPath: string | null = null;
    loadPgConfig({
      env: { PULSE5_PG_CONFIG_PATH: '/tmp/custom.json' } as NodeJS.ProcessEnv,
      readFile: (p: string) => {
        observedPath = p;
        return fakeFileContents();
      },
    });
    expect(observedPath).toBe('/tmp/custom.json');
  });

  it('throws a non-leaking error when file cannot be read', () => {
    expect(() =>
      loadPgConfig({
        env: { PULSE5_PG_CONFIG_PATH: '/no/such/file' } as NodeJS.ProcessEnv,
        readFile: () => {
          const err = new Error('ENOENT');
          (err as NodeJS.ErrnoException).code = 'ENOENT';
          throw err;
        },
      })
    ).toThrow(/cannot read postgres config/);
  });

  it('throws clearly on missing required fields without echoing the password', () => {
    const broken = JSON.stringify({ postgres: { host: 'h' } });
    let captured: unknown = null;
    try {
      loadPgConfig({ env: {} as NodeJS.ProcessEnv, readFile: () => broken });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    const msg = (captured as Error).message;
    expect(msg).toContain('missing required fields');
    expect(msg).not.toContain(PASSWORD_FIXTURE);
  });

  it('rejects bad JSON without leaking file contents', () => {
    expect(() =>
      loadPgConfig({
        env: {} as NodeJS.ProcessEnv,
        readFile: () => `${PASSWORD_FIXTURE}-not-json`,
      })
    ).toThrow(/not valid JSON/);
  });

  it('rejects when ssl_mode=require would still set ssl flag', () => {
    const cfg = loadPgConfig({
      env: {} as NodeJS.ProcessEnv,
      readFile: () => fakeFileContents({ ssl_mode: 'require' }),
    });
    expect(cfg.poolConfig.ssl).toBe(true);
  });
});

describe('redactDsn', () => {
  it('redacts the password segment', () => {
    expect(__internal.redactDsn(`postgres://u:${PASSWORD_FIXTURE}@h:5432/d`)).toBe(
      'postgres://u:***@h:5432/d'
    );
  });

  it('returns the original string when there is no embedded password', () => {
    expect(__internal.redactDsn('postgres://h:5432/d')).toBe('postgres://h:5432/d');
  });
});

describe('buildPoolConfigFromFile selectDatabase fallback', () => {
  it('rejects when target is unknown and file has no databases at all', () => {
    expect(() =>
      buildPoolConfigFromFile(
        { host: 'h', port: 1, username: 'u', password: 'p' },
        'main'
      )
    ).toThrow(/no database for target "main"/);
  });
});

import { describe, it, expect } from 'vitest';
import {
  redactDsn,
  parsePostgresFile,
  selectDatabase,
  buildDatabaseUrl,
  resolveConnection,
} from './run-migrate.mjs';

const PASSWORD_FIXTURE = 'super-secret-pw-do-not-leak';

function fakeJson(overrides: Record<string, unknown> = {}): string {
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

describe('redactDsn', () => {
  it('redacts the password segment', () => {
    expect(redactDsn(`postgres://u:${PASSWORD_FIXTURE}@h:5432/d`)).toBe(
      'postgres://u:***@h:5432/d'
    );
  });

  it('returns <missing> for non-strings', () => {
    expect(redactDsn(undefined as unknown as string)).toBe('<missing>');
  });
});

describe('parsePostgresFile + selectDatabase + buildDatabaseUrl', () => {
  it('parses a healthy file and builds a usable DSN', () => {
    const parsed = parsePostgresFile(fakeJson());
    const built = buildDatabaseUrl(parsed, 'main');
    expect(built.dsn).toBe(`postgres://postgres:${encodeURIComponent(PASSWORD_FIXTURE)}@127.0.0.1:5432/pulse5`);
    expect(built.redacted).toBe('postgres://postgres:***@127.0.0.1:5432/pulse5');
    expect(built.redacted).not.toContain(PASSWORD_FIXTURE);
  });

  it('selects test database via target', () => {
    const parsed = parsePostgresFile(fakeJson());
    const built = buildDatabaseUrl(parsed, 'test');
    expect(built.dsn.endsWith('/pulse5_test')).toBe(true);
  });

  it('accepts a literal db name when target is not a known key', () => {
    const parsed = parsePostgresFile(fakeJson());
    expect(selectDatabase(parsed, 'pulse5_dev')).toBe('pulse5_dev');
  });

  it('throws on missing required fields without echoing the password', () => {
    let captured: unknown = null;
    try {
      parsePostgresFile(JSON.stringify({ postgres: { host: 'h' } }));
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).not.toContain(PASSWORD_FIXTURE);
  });

  it('rejects a JSON file without the postgres top-level key', () => {
    expect(() => parsePostgresFile(JSON.stringify({}))).toThrow(/postgres.*object/);
  });

  it('rejects malformed JSON without echoing the input', () => {
    expect(() => parsePostgresFile(`${PASSWORD_FIXTURE}-not-json`)).toThrow(/not valid JSON/);
  });

  it('URL-encodes special characters in user and password', () => {
    const parsed = parsePostgresFile(
      fakeJson({ username: 'us er', password: 'p@ss/word!' })
    );
    const built = buildDatabaseUrl(parsed, 'main');
    expect(built.dsn).toContain('us%20er');
    expect(built.dsn).toContain('p%40ss%2Fword!');
    expect(built.redacted).toBe('postgres://us%20er:***@127.0.0.1:5432/pulse5');
  });
});

describe('resolveConnection — env priority', () => {
  it('prefers DATABASE_URL from process env', () => {
    const result = resolveConnection({
      processEnv: { DATABASE_URL: `postgres://u:${PASSWORD_FIXTURE}@h:5432/d` } as NodeJS.ProcessEnv,
      envFileContent: 'DATABASE_URL=postgres://other:other@h:5432/d',
      readJson: () => {
        throw new Error('readJson should not be called when env is set');
      },
    });
    expect(result.source).toBe('env');
    expect(result.dsn).toBe(`postgres://u:${PASSWORD_FIXTURE}@h:5432/d`);
    expect(result.redacted).not.toContain(PASSWORD_FIXTURE);
  });

  it('falls back to .env file when env is unset', () => {
    const result = resolveConnection({
      processEnv: {} as NodeJS.ProcessEnv,
      envFileContent: `# comment\nDATABASE_URL=postgres://u:${PASSWORD_FIXTURE}@h:5432/d\n`,
      readJson: () => {
        throw new Error('readJson should not be called when .env has DATABASE_URL');
      },
    });
    expect(result.source).toBe('env-file');
    expect(result.redacted).not.toContain(PASSWORD_FIXTURE);
  });

  it('falls back to JSON file when env and .env are silent', () => {
    let observedPath: string | null = null;
    const result = resolveConnection({
      processEnv: { PULSE5_PG_CONFIG_PATH: 'C:\\custom\\postgres.json' } as NodeJS.ProcessEnv,
      envFileContent: '# nothing useful here\n',
      readJson: (p: string) => {
        observedPath = p;
        return fakeJson();
      },
    });
    expect(observedPath).toBe('C:\\custom\\postgres.json');
    expect(result.source).toBe('json-file');
    expect(result.redacted).toBe('postgres://postgres:***@127.0.0.1:5432/pulse5');
    expect(result.redacted).not.toContain(PASSWORD_FIXTURE);
  });

  it('throws a redacted message when JSON fallback file is missing', () => {
    expect(() =>
      resolveConnection({
        processEnv: { PULSE5_PG_CONFIG_PATH: '/no/such/path' } as NodeJS.ProcessEnv,
        envFileContent: null,
        readJson: () => {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        },
      })
    ).toThrow(/cannot resolve DATABASE_URL/);
  });

  it('selects the test database when PULSE5_DB_TARGET=test', () => {
    const result = resolveConnection({
      processEnv: { PULSE5_DB_TARGET: 'test' } as NodeJS.ProcessEnv,
      envFileContent: null,
      readJson: () => fakeJson(),
    });
    expect(result.dsn.endsWith('/pulse5_test')).toBe(true);
  });

  it('skips empty DATABASE_URL values in .env', () => {
    const result = resolveConnection({
      processEnv: {} as NodeJS.ProcessEnv,
      envFileContent: 'DATABASE_URL=\n',
      readJson: () => fakeJson(),
    });
    expect(result.source).toBe('json-file');
  });

  it('strips quoted values in .env', () => {
    const result = resolveConnection({
      processEnv: {} as NodeJS.ProcessEnv,
      envFileContent: `DATABASE_URL="postgres://u:${PASSWORD_FIXTURE}@h:5432/d"\n`,
      readJson: () => {
        throw new Error('should not be called');
      },
    });
    expect(result.dsn).toBe(`postgres://u:${PASSWORD_FIXTURE}@h:5432/d`);
    expect(result.redacted).not.toContain(PASSWORD_FIXTURE);
  });
});

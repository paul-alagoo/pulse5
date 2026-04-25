import { describe, it, expect } from 'vitest';
// @ts-expect-error — sibling .mjs has no .d.ts; helpers documented in JSDoc.
import { preflight, parseEnvFile, summarizeUrl, isLocalHost } from './db-preflight.mjs';

const ENV_OK = [
  'PULSE5_PG_HOST_PORT=5433',
  'DATABASE_URL=postgres://pulse5:pulse5@localhost:5433/pulse5',
].join('\n');

describe('parseEnvFile', () => {
  it('parses KEY=value lines and ignores comments / blank lines', () => {
    const out = parseEnvFile(
      [
        '# a comment',
        '',
        'FOO=bar',
        'BAZ=qux quux', // value with whitespace inside
        '   ',
      ].join('\n')
    );
    expect(out).toEqual({ FOO: 'bar', BAZ: 'qux quux' });
  });

  it('strips matching surrounding quotes but not mismatched ones', () => {
    const out = parseEnvFile(
      ['A="hello"', "B='world'", 'C="mismatch\''].join('\n')
    );
    expect(out.A).toBe('hello');
    expect(out.B).toBe('world');
    expect(out.C).toBe('"mismatch\'');
  });

  it('handles CRLF line endings (Windows)', () => {
    const out = parseEnvFile('A=1\r\nB=2\r\n');
    expect(out).toEqual({ A: '1', B: '2' });
  });
});

describe('summarizeUrl', () => {
  it('extracts host / port / db without exposing credentials', () => {
    const s = summarizeUrl('postgres://u:secret@db.example:5432/app');
    expect(s).toEqual({ host: 'db.example', port: '5432', db: 'app' });
  });

  it('returns null for nullish inputs', () => {
    expect(summarizeUrl(null)).toBeNull();
    expect(summarizeUrl(undefined)).toBeNull();
    expect(summarizeUrl('')).toBeNull();
  });

  it('reports <unparseable> for malformed urls instead of throwing', () => {
    expect(summarizeUrl('not a url')).toEqual({
      host: '<unparseable>',
      port: null,
      db: null,
    });
  });

  it('does not surface query-string credentials (regression: only host/port/db are returned)', () => {
    const s = summarizeUrl(
      'postgres://localhost:5432/db?password=querysecret&user=queryuser'
    );
    expect(s).toEqual({ host: 'localhost', port: '5432', db: 'db' });
    expect(JSON.stringify(s)).not.toContain('querysecret');
    expect(JSON.stringify(s)).not.toContain('queryuser');
  });
});

describe('isLocalHost', () => {
  it.each([['localhost'], ['127.0.0.1'], ['::1']])(
    'treats %s as local',
    (host) => {
      expect(isLocalHost(host)).toBe(true);
    }
  );

  it.each([['db.internal'], ['10.0.0.5'], [''], [null], [undefined]])(
    'treats %s as remote / unknown',
    (host) => {
      expect(isLocalHost(host as string)).toBe(false);
    }
  );
});

describe('preflight()', () => {
  it('passes when shell DATABASE_URL matches root .env', () => {
    const r = preflight({
      envFileContent: ENV_OK,
      processEnv: { DATABASE_URL: 'postgres://pulse5:pulse5@localhost:5433/pulse5' },
    });
    expect(r).toEqual({ ok: true });
  });

  it('passes when shell DATABASE_URL is unset', () => {
    const r = preflight({ envFileContent: ENV_OK, processEnv: {} });
    expect(r).toEqual({ ok: true });
  });

  it('fails when shell DATABASE_URL points to a different host', () => {
    const r = preflight({
      envFileContent: ENV_OK,
      processEnv: { DATABASE_URL: 'postgres://u:p@otherhost:5432/wrongdb' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('shell-database-url-mismatch');
    expect(r.exitCode).toBe(12);
    // Error message is informative — names both sides by host/port/db.
    expect(r.message).toContain('otherhost');
    expect(r.message).toContain('localhost');
    expect(r.message).toContain('5433');
    expect(r.message).toContain('PULSE5_ALLOW_EXTERNAL_DATABASE_URL=1');
  });

  it('does NOT print credentials in the mismatch error', () => {
    const r = preflight({
      envFileContent: ENV_OK,
      processEnv: {
        DATABASE_URL: 'postgres://leakyuser:supersecret@otherhost:5432/wrongdb',
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).not.toContain('leakyuser');
    expect(r.message).not.toContain('supersecret');
  });

  it('does NOT print credentials from root .env either', () => {
    const r = preflight({
      envFileContent:
        [
          'PULSE5_PG_HOST_PORT=5433',
          'DATABASE_URL=postgres://envuser:envsecret@localhost:5433/pulse5',
        ].join('\n'),
      processEnv: {
        DATABASE_URL: 'postgres://shelluser:shellsecret@otherhost:5432/wrongdb',
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).not.toContain('envuser');
    expect(r.message).not.toContain('envsecret');
    expect(r.message).not.toContain('shelluser');
    expect(r.message).not.toContain('shellsecret');
  });

  it('allows shell DATABASE_URL override when escape hatch is set', () => {
    const r = preflight({
      envFileContent: ENV_OK,
      processEnv: {
        DATABASE_URL: 'postgres://u:p@otherhost:5432/ci',
        PULSE5_ALLOW_EXTERNAL_DATABASE_URL: '1',
      },
    });
    expect(r).toEqual({ ok: true });
  });

  it('fails when PULSE5_PG_HOST_PORT and DATABASE_URL port disagree (local host)', () => {
    const drift = [
      'PULSE5_PG_HOST_PORT=5433',
      'DATABASE_URL=postgres://pulse5:pulse5@localhost:5432/pulse5',
    ].join('\n');
    const r = preflight({ envFileContent: drift, processEnv: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('port-mismatch');
    expect(r.exitCode).toBe(13);
    expect(r.message).toContain('PULSE5_PG_HOST_PORT=5432');
    expect(r.message).toContain('localhost:5432');
  });

  it('does NOT enforce port consistency for remote hosts', () => {
    const remote = [
      'PULSE5_PG_HOST_PORT=5433',
      'DATABASE_URL=postgres://u:p@db.internal:5432/prod',
    ].join('\n');
    expect(preflight({ envFileContent: remote, processEnv: {} })).toEqual({
      ok: true,
    });
  });

  it('fails when root .env is missing', () => {
    const r = preflight({ envFileContent: null, processEnv: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('env-file-missing');
    expect(r.exitCode).toBe(10);
  });

  it('fails when root .env has no DATABASE_URL', () => {
    const r = preflight({
      envFileContent: 'PULSE5_PG_HOST_PORT=5433\n',
      processEnv: {},
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('env-file-missing-database-url');
    expect(r.exitCode).toBe(11);
  });

  it('escape hatch + port-mismatched .env passes (the .env URL is not used at runtime)', () => {
    // Scenario: CI runner injects an external DATABASE_URL deliberately
    // and sets PULSE5_ALLOW_EXTERNAL_DATABASE_URL=1. The committed `.env`
    // still has a stale local-port pair. The runtime DB is the shell URL,
    // so the .env port pairing is irrelevant — preflight must NOT block.
    const drift = [
      'PULSE5_PG_HOST_PORT=5433',
      'DATABASE_URL=postgres://pulse5:pulse5@localhost:5432/pulse5',
    ].join('\n');
    const r = preflight({
      envFileContent: drift,
      processEnv: {
        DATABASE_URL: 'postgres://u:p@ci-db.internal:6543/ci',
        PULSE5_ALLOW_EXTERNAL_DATABASE_URL: '1',
      },
    });
    expect(r).toEqual({ ok: true });
  });

  it('escape hatch alone (no shell DATABASE_URL) does NOT skip the port-mismatch check', () => {
    // The escape hatch only suppresses the .env port check when the .env
    // URL is overridden by a real shell URL. With no shell URL set, .env
    // IS the runtime DB — port-mismatch is still a real configuration bug.
    const drift = [
      'PULSE5_PG_HOST_PORT=5433',
      'DATABASE_URL=postgres://pulse5:pulse5@localhost:5432/pulse5',
    ].join('\n');
    const r = preflight({
      envFileContent: drift,
      processEnv: { PULSE5_ALLOW_EXTERNAL_DATABASE_URL: '1' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('port-mismatch');
  });

  it('shell-mismatch check runs before port-mismatch check', () => {
    // Even when both errors apply, the shell mismatch is the more
    // dangerous failure — surface it first so the user fixes it.
    const drift = [
      'PULSE5_PG_HOST_PORT=5433',
      'DATABASE_URL=postgres://pulse5:pulse5@localhost:5432/pulse5',
    ].join('\n');
    const r = preflight({
      envFileContent: drift,
      processEnv: { DATABASE_URL: 'postgres://u:p@otherhost:6543/x' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('shell-database-url-mismatch');
  });
});

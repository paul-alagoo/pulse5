import { describe, it, expect } from 'vitest';
// @ts-expect-error — sibling .mjs has no .d.ts; helper signature documented in JSDoc.
import { classifyDockerInspectFailure } from './wait-for-postgres.mjs';

describe('classifyDockerInspectFailure', () => {
  it('returns "daemon-unavailable" for the Windows Docker Desktop named-pipe error', () => {
    // Real stderr observed in this project's environment when the Linux
    // engine VM is not running.
    const stderr =
      'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/...": ' +
      'open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.';
    expect(classifyDockerInspectFailure({ stderr })).toBe('daemon-unavailable');
  });

  it('returns "daemon-unavailable" for the Linux unix-socket failure', () => {
    const stderr =
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
    expect(classifyDockerInspectFailure({ stderr })).toBe('daemon-unavailable');
  });

  it('returns "daemon-unavailable" when spawn ENOENTs (docker CLI missing on PATH)', () => {
    expect(
      classifyDockerInspectFailure({
        stderr: '',
        errorMessage: 'spawn docker ENOENT',
      })
    ).toBe('daemon-unavailable');
  });

  it('returns "permission-denied" for permission errors', () => {
    expect(
      classifyDockerInspectFailure({
        stderr:
          'permission denied while trying to connect to the Docker daemon socket',
      })
    ).toBe('permission-denied');
  });

  it('returns "permission-denied" for Windows ACL denial', () => {
    expect(classifyDockerInspectFailure({ stderr: 'Access is denied.' })).toBe(
      'permission-denied'
    );
  });

  it('returns "container-missing" when docker reports no such object', () => {
    expect(
      classifyDockerInspectFailure({
        stderr: 'Error: No such object: pulse5-postgres',
      })
    ).toBe('container-missing');
  });

  it('returns "container-missing" for "No such container"', () => {
    expect(
      classifyDockerInspectFailure({ stderr: 'Error: No such container: foo' })
    ).toBe('container-missing');
  });

  it('returns "unknown" for an unrecognised stderr', () => {
    expect(classifyDockerInspectFailure({ stderr: 'bzzt something weird' })).toBe(
      'unknown'
    );
  });

  it('returns "unknown" when called with no input at all', () => {
    expect(classifyDockerInspectFailure()).toBe('unknown');
    expect(classifyDockerInspectFailure({})).toBe('unknown');
  });

  it('prefers "permission-denied" over "daemon-unavailable" when both keywords are present', () => {
    // Some shells layer messages; check classifier ordering is stable.
    const stderr =
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock — permission denied';
    expect(classifyDockerInspectFailure({ stderr })).toBe('permission-denied');
  });
});

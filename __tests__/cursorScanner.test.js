/**
 * CursorScanner Tests
 * Process detection, transcript scanning, state inference, subagent detection
 *
 * Uses mocked fs/child_process to avoid sandbox filesystem restrictions.
 */

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

const realFs = jest.requireActual('fs');

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    readdirSync: jest.fn(actual.readdirSync),
    statSync: jest.fn(actual.statSync),
    readFileSync: jest.fn(actual.readFileSync),
    openSync: jest.fn(actual.openSync),
    readSync: jest.fn(actual.readSync),
    closeSync: jest.fn(actual.closeSync),
  };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let CursorScanner;

function loadFreshModule() {
  const modulePath = require.resolve('../src/cursorScanner');
  delete require.cache[modulePath];
  CursorScanner = require('../src/cursorScanner');
}

function createMockAgentManager() {
  return {
    updateAgent: jest.fn(),
    removeAgent: jest.fn(),
  };
}

const HOME = os.homedir();
const CURSOR_PROJECTS_DIR = path.join(HOME, '.cursor', 'projects');

function makeDirEntry(name, isDir = true) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

describe('CursorScanner', () => {
  let scanner;
  let agentManager;
  let debugLog;

  beforeEach(() => {
    jest.clearAllMocks();
    loadFreshModule();
    agentManager = createMockAgentManager();
    debugLog = jest.fn();
    scanner = new CursorScanner(agentManager, debugLog);

    // Default: Cursor is running
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; }
      cb(null, '12345\n', '');
    });
  });

  afterEach(() => {
    scanner.stop();
  });

  describe('constructor', () => {
    test('initializes with defaults', () => {
      expect(scanner.cursorRunning).toBe(false);
      expect(scanner.trackedSessions.size).toBe(0);
      expect(scanner.pollInterval).toBeNull();
    });
  });

  describe('_agentId', () => {
    test('prefixes uuid with cursor-', () => {
      expect(scanner._agentId('abc-123')).toBe('cursor-abc-123');
    });
  });

  describe('_decodeProjectName', () => {
    test('returns short names as-is', () => {
      expect(scanner._decodeProjectName('ab-cd')).toBe('ab-cd');
    });

    test('returns single segment as-is', () => {
      expect(scanner._decodeProjectName('foo')).toBe('foo');
    });

    test('strips known home segments from long names', () => {
      const result = scanner._decodeProjectName('Users-test-user-my-cool-project');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('_isFromToday', () => {
    test('returns true for timestamps from today', () => {
      expect(scanner._isFromToday(Date.now())).toBe(true);
      expect(scanner._isFromToday(Date.now() - 1000)).toBe(true);
    });

    test('returns false for timestamps from two days ago', () => {
      expect(scanner._isFromToday(Date.now() - 172800000)).toBe(false);
    });
  });

  describe('_readLastEntry', () => {
    test('reads last JSON line from file', () => {
      const lines = [
        JSON.stringify({ role: 'user', message: 'hello' }),
        JSON.stringify({ role: 'assistant', message: 'hi' }),
      ].join('\n') + '\n';
      const buf = Buffer.from(lines);

      fs.statSync.mockReturnValue({ size: buf.length });
      fs.openSync.mockReturnValue(42);
      fs.readSync.mockImplementation((fd, target, offset, length, pos) => {
        buf.copy(target, offset, pos, pos + length);
        return length;
      });
      fs.closeSync.mockReturnValue(undefined);

      const entry = scanner._readLastEntry('/fake/path.jsonl');
      expect(entry.role).toBe('assistant');
    });

    test('returns null for non-existent file', () => {
      fs.statSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(scanner._readLastEntry('/nonexistent')).toBeNull();
    });
  });

  describe('_poll', () => {
    const now = Date.now();
    const sessionUuid = 'aaaa-bbbb-cccc';
    const projectDirName = 'Users-testuser-my-project';
    const transcriptsDir = path.join(CURSOR_PROJECTS_DIR, projectDirName, 'agent-transcripts');
    const sessionDir = path.join(transcriptsDir, sessionUuid);
    const jsonlPath = path.join(sessionDir, `${sessionUuid}.jsonl`);

    function setupSingleSession(mtimeMs, role = 'assistant') {
      const line = JSON.stringify({ role, message: 'working' });
      const contentBuf = Buffer.from(line + '\n');

      fs.existsSync.mockImplementation((p) => {
        if (p === CURSOR_PROJECTS_DIR) return true;
        if (p === transcriptsDir) return true;
        return false;
      });
      fs.readdirSync.mockImplementation((p, opts) => {
        if (p === CURSOR_PROJECTS_DIR) return [makeDirEntry(projectDirName)];
        if (p === transcriptsDir) return [makeDirEntry(sessionUuid)];
        return [];
      });
      fs.statSync.mockImplementation((p) => {
        if (p === jsonlPath) return { size: contentBuf.length, mtimeMs: mtimeMs || now };
        throw new Error('ENOENT');
      });
      fs.openSync.mockReturnValue(42);
      fs.readSync.mockImplementation((fd, target, offset, length, pos) => {
        contentBuf.copy(target, offset, 0, Math.min(length, contentBuf.length));
        return Math.min(length, contentBuf.length);
      });
      fs.closeSync.mockReturnValue(undefined);
    }

    test('registers agent for today\'s transcript', async () => {
      setupSingleSession(now - 5000);
      await scanner._poll();

      expect(agentManager.updateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: `cursor-${sessionUuid}`,
          isCursor: true,
          model: 'cursor-agent',
          isSubagent: false,
        }),
        'cursor'
      );
    });

    test('does not register agent for old transcripts', async () => {
      const twoDaysAgo = now - 172800000;
      setupSingleSession(twoDaysAgo);
      await scanner._poll();

      expect(agentManager.updateAgent).not.toHaveBeenCalled();
    });

    test('removes agents when Cursor process exits', async () => {
      setupSingleSession(now - 5000);
      await scanner._poll();
      expect(agentManager.updateAgent).toHaveBeenCalled();
      expect(scanner.cursorRunning).toBe(true);

      // Simulate Cursor exit
      execFile.mockImplementation((cmd, args, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; }
        cb(new Error('no match'), '', '');
      });

      await scanner._poll();
      expect(agentManager.removeAgent).toHaveBeenCalledWith(`cursor-${sessionUuid}`);
      expect(scanner.cursorRunning).toBe(false);
      expect(scanner.trackedSessions.size).toBe(0);
    });

    test('picks most recent session per project', async () => {
      const olderUuid = 'older-uuid-1111';
      const newerUuid = 'newer-uuid-2222';
      const olderPath = path.join(transcriptsDir, olderUuid, `${olderUuid}.jsonl`);
      const newerPath = path.join(transcriptsDir, newerUuid, `${newerUuid}.jsonl`);

      fs.existsSync.mockImplementation((p) => {
        if (p === CURSOR_PROJECTS_DIR || p === transcriptsDir) return true;
        return false;
      });
      fs.readdirSync.mockImplementation((p) => {
        if (p === CURSOR_PROJECTS_DIR) return [makeDirEntry(projectDirName)];
        if (p === transcriptsDir) return [makeDirEntry(olderUuid), makeDirEntry(newerUuid)];
        return [];
      });
      const line = JSON.stringify({ role: 'assistant', message: 'hi' });
      const buf = Buffer.from(line + '\n');

      fs.statSync.mockImplementation((p) => {
        if (p === olderPath) return { size: buf.length, mtimeMs: now - 60000 };
        if (p === newerPath) return { size: buf.length, mtimeMs: now - 5000 };
        throw new Error('ENOENT');
      });
      fs.openSync.mockReturnValue(42);
      fs.readSync.mockImplementation((fd, target, offset, length) => {
        buf.copy(target, offset, 0, Math.min(length, buf.length));
        return Math.min(length, buf.length);
      });
      fs.closeSync.mockReturnValue(undefined);

      await scanner._poll();

      const sessionIds = agentManager.updateAgent.mock.calls.map(c => c[0].sessionId);
      expect(sessionIds).toContain(`cursor-${newerUuid}`);
      expect(sessionIds).not.toContain(`cursor-${olderUuid}`);
    });

    test('infers Thinking state when last entry is user', async () => {
      setupSingleSession(now - 5000, 'user');

      await scanner._poll();

      expect(agentManager.updateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'Thinking' }),
        'cursor'
      );
    });

    test('infers Working state when last entry is assistant', async () => {
      setupSingleSession(now - 5000);
      await scanner._poll();

      expect(agentManager.updateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'Working' }),
        'cursor'
      );
    });

    test('skips projects with no agent-transcripts directory', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (p === CURSOR_PROJECTS_DIR) return true;
        return false; // transcriptsDir doesn't exist
      });
      fs.readdirSync.mockImplementation((p) => {
        if (p === CURSOR_PROJECTS_DIR) return [makeDirEntry('some-project')];
        return [];
      });

      await scanner._poll();
      expect(agentManager.updateAgent).not.toHaveBeenCalled();
    });

    test('does nothing when .cursor/projects does not exist', async () => {
      fs.existsSync.mockReturnValue(false);
      await scanner._poll();
      expect(agentManager.updateAgent).not.toHaveBeenCalled();
    });
  });

  describe('subagent detection', () => {
    test('registers subagents linked to parent', async () => {
      const now = Date.now();
      const parentUuid = 'parent-uuid-1111';
      const subUuid = 'sub-uuid-2222';
      const projectDirName = 'Users-test-my-app';
      const transcriptsDir = path.join(CURSOR_PROJECTS_DIR, projectDirName, 'agent-transcripts');
      const parentJsonl = path.join(transcriptsDir, parentUuid, `${parentUuid}.jsonl`);
      const subDir = path.join(transcriptsDir, parentUuid, 'subagents');
      const subJsonl = path.join(subDir, `${subUuid}.jsonl`);

      fs.existsSync.mockImplementation((p) => {
        if (p === CURSOR_PROJECTS_DIR || p === transcriptsDir || p === subDir) return true;
        return false;
      });
      fs.readdirSync.mockImplementation((p, opts) => {
        if (p === CURSOR_PROJECTS_DIR) return [makeDirEntry(projectDirName)];
        if (p === transcriptsDir) return [makeDirEntry(parentUuid)];
        if (p === subDir) return ['sub-uuid-2222.jsonl'];
        return [];
      });
      const line = JSON.stringify({ role: 'assistant', message: 'working on it' });
      const buf = Buffer.from(line + '\n');

      fs.statSync.mockImplementation((p) => {
        if (p === parentJsonl) return { size: buf.length, mtimeMs: now - 5000 };
        if (p === subJsonl) return { size: buf.length, mtimeMs: now - 3000 };
        throw new Error('ENOENT');
      });
      fs.openSync.mockReturnValue(42);
      fs.readSync.mockImplementation((fd, target, offset, length) => {
        buf.copy(target, offset, 0, Math.min(length, buf.length));
        return Math.min(length, buf.length);
      });
      fs.closeSync.mockReturnValue(undefined);

      await scanner._poll();

      const calls = agentManager.updateAgent.mock.calls;
      const subCall = calls.find(c => c[0].sessionId === `cursor-${subUuid}`);
      expect(subCall).toBeTruthy();
      expect(subCall[0].isSubagent).toBe(true);
      expect(subCall[0].parentId).toBe(`cursor-${parentUuid}`);
    });
  });

  describe('start and stop', () => {
    test('start sets interval and stop clears it', () => {
      jest.useFakeTimers();
      scanner._poll = jest.fn();

      scanner.start(10000);
      expect(scanner.pollInterval).not.toBeNull();
      expect(scanner._poll).toHaveBeenCalledTimes(1);

      scanner.stop();
      expect(scanner.pollInterval).toBeNull();

      jest.useRealTimers();
    });

    test('stop is safe when not started', () => {
      expect(() => scanner.stop()).not.toThrow();
    });
  });

  describe('_removeAllTracked', () => {
    test('removes all tracked agents and clears map', () => {
      scanner.trackedSessions.set('cursor-a', { mtimeMs: 0 });
      scanner.trackedSessions.set('cursor-b', { mtimeMs: 0 });

      scanner._removeAllTracked();

      expect(agentManager.removeAgent).toHaveBeenCalledTimes(2);
      expect(scanner.trackedSessions.size).toBe(0);
    });
  });

  describe('_checkCursorProcess', () => {
    test('resolves true when pgrep finds Cursor', async () => {
      const freshScanner = new CursorScanner(agentManager, debugLog);
      execFile.mockImplementation((cmd, args, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; }
        cb(null, '12345\n', '');
      });

      const result = await freshScanner._checkCursorProcess();
      expect(result).toBe(true);
    });

    test('resolves false when pgrep finds nothing', async () => {
      const freshScanner = new CursorScanner(agentManager, debugLog);
      execFile.mockImplementation((cmd, args, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; }
        cb(new Error('exit code 1'), '', '');
      });

      const result = await freshScanner._checkCursorProcess();
      expect(result).toBe(false);
    });
  });
});

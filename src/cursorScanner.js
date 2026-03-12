/**
 * Cursor Agent Scanner
 * Detects active Cursor IDE agent sessions by monitoring transcript JSONL
 * files under ~/.cursor/projects/<project>/agent-transcripts/.
 *
 * Liveness strategy:
 *   1. Check if a Cursor process is running (pgrep / tasklist).
 *   2. If Cursor is running, show the most-recently-modified session per
 *      project as an agent (file must have been modified during this
 *      calendar day to avoid resurrecting old sessions).
 *   3. Infer state from recency + last JSONL role:
 *        - modified within ACTIVE_WINDOW → Working / Thinking
 *        - older but still today's session → Waiting
 *   4. When Cursor exits, all tracked agents are removed.
 *
 * Architecture note — lifecycle deviation:
 *   The CONTRIBUTING.md rule "Agent lifecycle is PID-based only" applies to
 *   Claude Code agents, where each session maps to a single OS process.
 *   Cursor hosts many agent sessions inside one Electron process, so
 *   per-session PIDs don't exist. Instead, lifecycle is process-based
 *   (pgrep Cursor.app) combined with transcript file state. Agents are
 *   removed only when Cursor exits or the session is superseded — no
 *   manual dismiss or idle-timer removal is used.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CURSOR_PROJECTS_DIR = path.join(os.homedir(), '.cursor', 'projects');
const POLL_INTERVAL_MS = 5000;
const ACTIVE_WINDOW_MS = 30_000;

class CursorScanner {
  /**
   * @param {import('./agentManager')} agentManager
   * @param {(msg: string) => void} [debugLog]
   */
  constructor(agentManager, debugLog = () => {}) {
    this.agentManager = agentManager;
    this.debugLog = debugLog;
    this.pollInterval = null;
    this.cursorRunning = false;
    /** @type {Map<string, TrackedSession>} agentId → { mtimeMs, jsonlPath } */
    this.trackedSessions = new Map();
  }

  start(intervalMs = POLL_INTERVAL_MS) {
    this.debugLog('[CursorScanner] Started');
    this._poll();
    this.pollInterval = setInterval(() => this._poll(), intervalMs);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.debugLog('[CursorScanner] Stopped');
  }

  /**
   * Decode a Cursor project directory name into a human-readable project name.
   * e.g. "Users-jane-doe-my-cool-project" → "my-cool-project"
   */
  _decodeProjectName(dirName) {
    const parts = dirName.split('-');
    if (parts.length <= 3) return dirName;

    // Strip the homedir prefix from the encoded directory name.
    // Cursor encodes the full path with dashes, so ~/Projects/foo becomes
    // "Users-jane-doe-Projects-foo". We match the homedir segments and
    // take everything after them as the project name.
    const homeSegments = os.homedir().split(path.sep).filter(Boolean);
    const homeNormalized = homeSegments.map(s => s.replace(/\./g, '-'));
    let skipCount = 0;
    let partIdx = 0;
    for (const seg of homeNormalized) {
      const segParts = seg.split('-');
      for (const sp of segParts) {
        if (partIdx < parts.length && parts[partIdx].toLowerCase() === sp.toLowerCase()) {
          partIdx++;
          skipCount = partIdx;
        }
      }
    }
    const projectParts = parts.slice(skipCount);
    return projectParts.length > 0 ? projectParts.join('-') : dirName;
  }

  _agentId(sessionUuid) {
    return `cursor-${sessionUuid}`;
  }

  /**
   * Read the last complete line of a file efficiently.
   * Returns parsed JSON or null.
   */
  _readLastEntry(filePath) {
    try {
      const stat = fs.statSync(filePath);
      const readSize = Math.min(stat.size, 8192);
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
        const chunk = buf.toString('utf-8');
        const lines = chunk.trim().split('\n').filter(Boolean);
        if (lines.length === 0) return null;
        return JSON.parse(lines[lines.length - 1]);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  /**
   * Count messages in the transcript (lightweight: count lines by role).
   */
  _countMessages(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      let user = 0, assistant = 0;
      for (const line of lines) {
        if (line.includes('"role":"user"') || line.includes('"role": "user"')) user++;
        else if (line.includes('"role":"assistant"') || line.includes('"role": "assistant"')) assistant++;
      }
      return { user, assistant };
    } catch {
      return { user: 0, assistant: 0 };
    }
  }

  /**
   * Check if Cursor IDE is running as a process.
   */
  _checkCursorProcess() {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        execFile('tasklist', ['/FI', 'IMAGENAME eq Cursor.exe', '/NH'], { timeout: 3000 }, (err, stdout) => {
          resolve(!err && stdout && stdout.toLowerCase().includes('cursor'));
        });
      } else {
        execFile('pgrep', ['-f', 'Cursor.app'], { timeout: 3000 }, (err, stdout) => {
          resolve(!err && stdout && stdout.trim().length > 0);
        });
      }
    });
  }

  /**
   * Returns true if the file was modified today (local time).
   */
  _isFromToday(mtimeMs) {
    const fileDate = new Date(mtimeMs);
    const today = new Date();
    return fileDate.getFullYear() === today.getFullYear()
      && fileDate.getMonth() === today.getMonth()
      && fileDate.getDate() === today.getDate();
  }

  async _poll() {
    if (!fs.existsSync(CURSOR_PROJECTS_DIR)) return;

    const isCursorUp = await this._checkCursorProcess();

    if (!isCursorUp) {
      if (this.cursorRunning) {
        this.debugLog('[CursorScanner] Cursor exited');
        this.cursorRunning = false;
        this._removeAllTracked();
      }
      return;
    }

    if (!this.cursorRunning) {
      this.debugLog('[CursorScanner] Cursor detected');
      this.cursorRunning = true;
    }

    const now = Date.now();
    const activeIds = new Set();

    let projectDirs;
    try {
      projectDirs = fs.readdirSync(CURSOR_PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());
    } catch { return; }

    for (const projDir of projectDirs) {
      const transcriptsDir = path.join(CURSOR_PROJECTS_DIR, projDir.name, 'agent-transcripts');
      if (!fs.existsSync(transcriptsDir)) continue;

      const projectName = this._decodeProjectName(projDir.name);

      let sessionDirs;
      try {
        sessionDirs = fs.readdirSync(transcriptsDir, { withFileTypes: true })
          .filter(d => d.isDirectory());
      } catch { continue; }

      // Find the most recently modified session for this project
      let bestSession = null;
      for (const sessDir of sessionDirs) {
        const uuid = sessDir.name;
        const jsonlPath = path.join(transcriptsDir, uuid, `${uuid}.jsonl`);

        let stat;
        try { stat = fs.statSync(jsonlPath); } catch { continue; }

        if (!this._isFromToday(stat.mtimeMs)) continue;

        if (!bestSession || stat.mtimeMs > bestSession.mtimeMs) {
          bestSession = { uuid, jsonlPath, mtimeMs: stat.mtimeMs };
        }
      }

      if (!bestSession) continue;

      const { uuid, jsonlPath, mtimeMs } = bestSession;
      const agentId = this._agentId(uuid);
      activeIds.add(agentId);

      const prev = this.trackedSessions.get(agentId);
      const fileChanged = !prev || prev.mtimeMs !== mtimeMs;
      const isRecentlyActive = (now - mtimeMs) < ACTIVE_WINDOW_MS;

      let state = 'Waiting';
      if (isRecentlyActive && fileChanged) {
        const lastEntry = this._readLastEntry(jsonlPath);
        if (lastEntry) {
          state = lastEntry.role === 'user' ? 'Thinking' : 'Working';
        }
      } else if (isRecentlyActive && prev) {
        state = prev.lastState || 'Waiting';
      }
      // else: file is from today but not recently active → Waiting

      this.trackedSessions.set(agentId, {
        mtimeMs,
        jsonlPath,
        projectName,
        uuid,
        lastState: state,
      });

      this.agentManager.updateAgent({
        sessionId: agentId,
        projectPath: `cursor/${projectName}`,
        displayName: `${projectName} (Cursor)`,
        state,
        model: 'cursor-agent',
        isSubagent: false,
        isTeammate: false,
        isCursor: true,
        currentTool: state === 'Working' ? 'edit' : null,
      }, 'cursor');

      // Also scan subagents
      this._scanSubagents(transcriptsDir, uuid, projectName, now, activeIds);
    }

    // Remove sessions that are no longer active
    for (const [agentId] of this.trackedSessions) {
      if (!activeIds.has(agentId)) {
        this.trackedSessions.delete(agentId);
        this.agentManager.removeAgent(agentId);
        this.debugLog(`[CursorScanner] Session ended → removed ${agentId}`);
      }
    }
  }

  _removeAllTracked() {
    for (const [agentId] of this.trackedSessions) {
      this.agentManager.removeAgent(agentId);
    }
    this.trackedSessions.clear();
  }

  _scanSubagents(transcriptsDir, parentUuid, projectName, now, activeIds) {
    const subDir = path.join(transcriptsDir, parentUuid, 'subagents');
    if (!fs.existsSync(subDir)) return;

    let files;
    try {
      files = fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'));
    } catch { return; }

    for (const file of files) {
      const subUuid = file.replace('.jsonl', '');
      const filePath = path.join(subDir, file);

      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }

      if (!this._isFromToday(stat.mtimeMs)) continue;

      const agentId = this._agentId(subUuid);
      activeIds.add(agentId);

      const prev = this.trackedSessions.get(agentId);
      const fileChanged = !prev || prev.mtimeMs !== stat.mtimeMs;
      const isRecentlyActive = (now - stat.mtimeMs) < ACTIVE_WINDOW_MS;

      let state = 'Waiting';
      if (isRecentlyActive && fileChanged) {
        const lastEntry = this._readLastEntry(filePath);
        if (lastEntry) {
          state = lastEntry.role === 'user' ? 'Thinking' : 'Working';
        }
      } else if (isRecentlyActive && prev) {
        state = prev.lastState || 'Waiting';
      }

      this.trackedSessions.set(agentId, {
        mtimeMs: stat.mtimeMs,
        jsonlPath: filePath,
        projectName,
        uuid: subUuid,
        lastState: state,
      });

      this.agentManager.updateAgent({
        sessionId: agentId,
        projectPath: `cursor/${projectName}`,
        displayName: `${projectName} (Cursor)`,
        state,
        model: 'cursor-agent',
        isSubagent: true,
        isTeammate: false,
        isCursor: true,
        parentId: this._agentId(parentUuid),
        currentTool: state === 'Working' ? 'edit' : null,
      }, 'cursor');
    }
  }
}

module.exports = CursorScanner;

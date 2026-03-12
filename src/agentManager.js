/**
 * Multi-Agent Manager
 * - P2-10: Only emit events on state changes
 * - Display name improvement: use cwd basename when slug is absent
 */

const EventEmitter = require('events');
const path = require('path');
const { formatSlugToDisplayName } = require('./utils');

// Single source of truth: public/shared/avatars.json
const AVATAR_FILES = require('../public/shared/avatars.json');
const AVATAR_COUNT = AVATAR_FILES.length;

/**
 * Merge a field: entry value wins if defined, then existing, then default.
 */
function mergeField(entry, existing, key, defaultVal = null) {
  if (entry[key] !== undefined) return entry[key];
  return existing ? existing[key] : defaultVal;
}

class AgentManager extends EventEmitter {
  constructor() {
    super();
    this.agents = new Map();
    this._pendingEmit = new Map(); // agentId → { timer, state } — UI emit debounce
    this._usedAvatarIndices = new Set(); // Currently used avatar indices
    this.config = {
      softLimitWarning: 50,  // Soft warning (does not block, only logs)
      stateDebounceMs: 500,  // Working→Thinking transition debounce (ms)
    };
  }

  start() {
    // Agent cleanup is handled exclusively by the main.js liveness checker (PID-based)
    console.log('[AgentManager] Started');
  }

  stop() {
    for (const pending of this._pendingEmit.values()) {
      clearTimeout(pending.timer);
    }
    this._pendingEmit.clear();
    this._usedAvatarIndices.clear();
    this.agents.clear();
    console.log('[AgentManager] Stopped');
  }

  /**
   * Update or add an agent
   */
  updateAgent(entry, source = 'log') {
    const agentId = entry.sessionId || entry.agentId || entry.uuid || 'unknown';
    const now = Date.now();
    const existingAgent = this.agents.get(agentId);

    // Soft warning: only warn if agent count is high (does not block registration)
    if (!existingAgent && this.agents.size >= this.config.softLimitWarning) {
      console.warn(`[AgentManager] ⚠ ${this.agents.size} agents active (soft limit: ${this.config.softLimitWarning}). Consider checking for stale sessions.`);
    }

    const prevState = existingAgent ? existingAgent.state : null;
    let newState = entry.state;
    if (!newState) newState = prevState || 'Done';

    let activeStartTime = existingAgent ? existingAgent.activeStartTime : now;
    let lastDuration = existingAgent ? existingAgent.lastDuration : 0;

    // When entering active state (Done/Error/Help/Waiting -> Working/Thinking)
    const isPassive = (s) => s === 'Done' || s === 'Help' || s === 'Error' || s === 'Waiting';
    const isActive = (s) => s === 'Working' || s === 'Thinking';

    if (isActive(newState) && (isPassive(prevState) || !existingAgent)) {
      activeStartTime = now;
    }

    // When returning to Done, save the last elapsed duration
    if (newState === 'Done' && existingAgent && isActive(prevState)) {
      lastDuration = now - activeStartTime;
    }

    const m = (key, defaultVal = null) => mergeField(entry, existingAgent, key, defaultVal);

    const agentData = {
      id: agentId,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      slug: entry.slug,
      displayName: entry.displayName || this.formatDisplayName(entry.slug, entry.projectPath),
      projectPath: entry.projectPath,
      jsonlPath: entry.jsonlPath || (existingAgent ? existingAgent.jsonlPath : null),
      model: m('model'),
      permissionMode: m('permissionMode'),
      source: m('source'),
      agentType: m('agentType'),
      currentTool: m('currentTool'),
      lastMessage: m('lastMessage'),
      endReason: m('endReason'),
      teammateName: m('teammateName'),
      teamName: m('teamName'),
      tokenUsage: m('tokenUsage', { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }),
      avatarIndex: existingAgent ? existingAgent.avatarIndex : this._assignAvatarIndex(agentId),
      isSubagent: entry.isSubagent || (existingAgent ? existingAgent.isSubagent : false),
      isTeammate: entry.isTeammate || (existingAgent ? existingAgent.isTeammate : false),
      parentId: entry.parentId || (existingAgent ? existingAgent.parentId : null),
      state: newState,
      activeStartTime,
      lastDuration,
      lastActivity: now,
      timestamp: entry.timestamp || now,
      firstSeen: existingAgent ? existingAgent.firstSeen : now,
      updateCount: existingAgent ? existingAgent.updateCount + 1 : 1
    };

    this.agents.set(agentId, agentData);

    // Refresh parent state when subagent state changes
    if (agentData.parentId) {
      this.reEvaluateParentState(agentData.parentId);
    }

    if (!existingAgent) {
      this._cancelPendingEmit(agentId);
      this.emit('agent-added', this.getAgentWithEffectiveState(agentId));
      console.log(`[AgentManager] Agent added: ${agentData.displayName} (${newState})`);
    } else if (newState !== prevState) {
      this._emitWithDebounce(agentId, prevState, newState, agentData.displayName);
    }

    return agentData;
  }

  /**
   * State transition debounce — delays Working→Thinking transitions by 500ms to prevent flickering
   * Thinking→Working (promotion) is applied immediately, canceling any pending emit
   */
  _emitWithDebounce(agentId, prevState, newState, displayName) {
    const isDowngrade = (prevState === 'Working' && newState === 'Thinking');

    if (isDowngrade) {
      // Working→Thinking: delayed emit (canceled if Working is re-entered within 500ms)
      this._cancelPendingEmit(agentId);
      const timer = setTimeout(() => {
        this._pendingEmit.delete(agentId);
        const current = this.agents.get(agentId);
        if (current && current.state === newState) {
          this.emit('agent-updated', this.getAgentWithEffectiveState(agentId));
        }
      }, this.config.stateDebounceMs);
      this._pendingEmit.set(agentId, { timer, state: newState });
    } else {
      // Immediate emit — cancel any pending emit
      this._cancelPendingEmit(agentId);
      this.emit('agent-updated', this.getAgentWithEffectiveState(agentId));
    }
  }

  _cancelPendingEmit(agentId) {
    const pending = this._pendingEmit.get(agentId);
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingEmit.delete(agentId);
    }
  }

  removeAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    this._cancelPendingEmit(agentId);
    this._releaseAvatarIndex(agent.avatarIndex);
    this.agents.delete(agentId);

    // Refresh parent state when subagent is removed
    if (agent.parentId) {
      this.reEvaluateParentState(agent.parentId);
    }

    this.emit('agent-removed', { id: agentId, displayName: agent.displayName });
    console.log(`[AgentManager] Removed: ${agent.displayName}`);
    return true;
  }

  getAllAgents() {
    return Array.from(this.agents.keys()).map(id => this.getAgentWithEffectiveState(id));
  }

  getAgentWithEffectiveState(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    // Return as-is if already in Help or Error state (highest priority)
    if (agent.state === 'Help' || agent.state === 'Error') return agent;

    // Check children (subagent) states
    const children = Array.from(this.agents.values()).filter(a => a.parentId === agentId);

    // 1. If any child is Help/Error, show parent as Help (notify user intervention needed)
    const someChildNeedsHelp = children.some(c => c.state === 'Help' || c.state === 'Error');
    if (someChildNeedsHelp) {
      return { ...agent, state: 'Help', isAggregated: true };
    }

    // Return as-is if already in Working state
    if (agent.state === 'Working' || agent.state === 'Thinking') return agent;

    // 2. If any child is Working/Thinking, show parent as Working
    const someChildWorking = children.some(c => c.state === 'Working' || c.state === 'Thinking');
    if (someChildWorking) {
      return { ...agent, state: 'Working', isAggregated: true };
    }

    return agent;
  }

  reEvaluateParentState(parentId) {
    const parent = this.agents.get(parentId);
    if (!parent) return;
    // Force emit parent state update event so the renderer recognizes it as Working
    this.emit('agent-updated', this.getAgentWithEffectiveState(parentId));
  }
  getAgent(agentId) { return this.agents.get(agentId) || null; }
  getAgentCount() { return this.agents.size; }
  getAgentsByActivity() {
    return this.getAllAgents().sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /**
   * Determine display name
   * 1. slug (e.g., "toasty-sparking-lecun" → "Toasty Sparking Lecun")
   * 2. basename of projectPath (e.g., "pixel-agent-desk-master")
   * 3. Fallback: "Agent"
   */
  formatDisplayName(slug, projectPath) {
    if (slug) {
      return formatSlugToDisplayName(slug);
    }
    if (projectPath) {
      return path.basename(projectPath);
    }
    return 'Agent';
  }

  /**
   * Assign avatar index — prioritize unused avatars on hash collision
   */
  _assignAvatarIndex(agentId) {
    let hash = 0;
    const str = agentId || '';
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    const hashIdx = Math.abs(hash) % AVATAR_COUNT;

    if (!this._usedAvatarIndices.has(hashIdx)) {
      this._usedAvatarIndices.add(hashIdx);
      return hashIdx;
    }

    // Hash collision: iterate through unused avatars
    for (let i = 0; i < AVATAR_COUNT; i++) {
      if (!this._usedAvatarIndices.has(i)) {
        this._usedAvatarIndices.add(i);
        return i;
      }
    }

    // All avatars in use, fall back to hash index
    return hashIdx;
  }

  /**
   * Release avatar index
   */
  _releaseAvatarIndex(avatarIndex) {
    if (avatarIndex !== undefined && avatarIndex !== null) {
      this._usedAvatarIndices.delete(avatarIndex);
    }
  }

  getStats() {
    const agents = this.getAllAgents();
    const counts = { Done: 0, Thinking: 0, Working: 0, Waiting: 0, Help: 0, Error: 0 };
    for (const agent of agents) {
      if (counts.hasOwnProperty(agent.state)) {
        counts[agent.state]++;
      }
    }
    return {
      total: agents.length,
      byState: counts
    };
  }
}

module.exports = AgentManager;

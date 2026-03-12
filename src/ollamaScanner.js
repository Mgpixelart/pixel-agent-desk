/**
 * Ollama Scanner
 * Polls the local Ollama API (/api/ps) to detect running models
 * and represent them as agents in the pixel-agent-desk.
 *
 * Each loaded model becomes an agent. Activity is inferred by
 * watching the `expires_at` field: if it advances between polls
 * the model is actively serving requests.
 */

'use strict';

const http = require('http');

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const POLL_INTERVAL_MS = 5000;

class OllamaScanner {
  /**
   * @param {import('./agentManager')} agentManager
   * @param {(msg: string) => void} [debugLog]
   */
  constructor(agentManager, debugLog = () => {}) {
    this.agentManager = agentManager;
    this.debugLog = debugLog;
    this.pollInterval = null;
    this.ollamaAvailable = false;
    /** @type {Map<string, TrackedModel>} agentId → last known state */
    this.trackedModels = new Map();
  }

  start(intervalMs = POLL_INTERVAL_MS) {
    this.debugLog('[OllamaScanner] Started');
    this._poll();
    this.pollInterval = setInterval(() => this._poll(), intervalMs);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.debugLog('[OllamaScanner] Stopped');
  }

  /**
   * Build a stable agent ID from the model name.
   * Uses the digest when available so two instances of the same model
   * name with different quantisations stay separate.
   */
  _agentId(model) {
    const base = model.digest
      ? `${model.name}@${model.digest.slice(0, 12)}`
      : model.name;
    return `ollama-${base}`;
  }

  /**
   * Fetch JSON from Ollama's local API.
   * Returns parsed body or null on any failure.
   */
  _fetch(path) {
    return new Promise((resolve) => {
      const req = http.get(
        { hostname: OLLAMA_HOST, port: OLLAMA_PORT, path, timeout: 3000 },
        (res) => {
          if (res.statusCode !== 200) { res.resume(); return resolve(null); }
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { resolve(null); }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  async _poll() {
    const data = await this._fetch('/api/ps');

    if (!data || !Array.isArray(data.models)) {
      if (this.ollamaAvailable) {
        this.debugLog('[OllamaScanner] Ollama went offline');
        this.ollamaAvailable = false;
        this._removeAllTracked();
      }
      return;
    }

    if (!this.ollamaAvailable) {
      this.debugLog('[OllamaScanner] Ollama detected');
      this.ollamaAvailable = true;
    }

    const currentIds = new Set();

    for (const model of data.models) {
      const agentId = this._agentId(model);
      currentIds.add(agentId);

      const prev = this.trackedModels.get(agentId);
      const expiresAt = model.expires_at || null;
      const isActive = prev && expiresAt && prev.expiresAt && expiresAt !== prev.expiresAt;
      const state = isActive ? 'Working' : 'Waiting';

      const details = model.details || {};
      const displayName = model.name.replace(/:latest$/, '');
      const paramSize = details.parameter_size || null;

      this.trackedModels.set(agentId, { expiresAt, model });

      this.agentManager.updateAgent({
        sessionId: agentId,
        projectPath: `ollama/${displayName}`,
        displayName: paramSize ? `${displayName} (${paramSize})` : displayName,
        state,
        model: model.name,
        isSubagent: false,
        isTeammate: false,
        isOllama: true,
        currentTool: state === 'Working' ? 'generate' : null,
      }, 'ollama');
    }

    // Remove agents for models that are no longer loaded
    for (const [agentId] of this.trackedModels) {
      if (!currentIds.has(agentId)) {
        this.trackedModels.delete(agentId);
        this.agentManager.removeAgent(agentId);
        this.debugLog(`[OllamaScanner] Model unloaded → removed ${agentId}`);
      }
    }
  }

  _removeAllTracked() {
    for (const [agentId] of this.trackedModels) {
      this.agentManager.removeAgent(agentId);
    }
    this.trackedModels.clear();
  }
}

module.exports = OllamaScanner;

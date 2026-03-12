/**
 * OllamaScanner Tests
 * Polling, model detection, state inference, cleanup
 */

const http = require('http');
const OllamaScanner = require('../src/ollamaScanner');

function createMockAgentManager() {
  return {
    updateAgent: jest.fn(),
    removeAgent: jest.fn(),
  };
}

function makeModel(name, opts = {}) {
  return {
    name,
    model: name,
    size: 5000000000,
    digest: opts.digest || 'abc123def456789',
    details: { parameter_size: opts.paramSize || '8B', format: 'gguf', family: 'llama' },
    expires_at: opts.expiresAt || '2026-03-12T12:00:00Z',
    size_vram: 5000000000,
  };
}

describe('OllamaScanner', () => {
  let scanner;
  let agentManager;
  let debugLog;

  beforeEach(() => {
    agentManager = createMockAgentManager();
    debugLog = jest.fn();
    scanner = new OllamaScanner(agentManager, debugLog);
  });

  afterEach(() => {
    scanner.stop();
  });

  describe('constructor', () => {
    test('initializes with defaults', () => {
      expect(scanner.ollamaAvailable).toBe(false);
      expect(scanner.trackedModels.size).toBe(0);
      expect(scanner.pollInterval).toBeNull();
    });
  });

  describe('_agentId', () => {
    test('includes digest when available', () => {
      const model = makeModel('llama3:8b');
      const id = scanner._agentId(model);
      expect(id).toBe('ollama-llama3:8b@abc123def456');
    });

    test('uses name only when no digest', () => {
      const id = scanner._agentId({ name: 'llama3:8b' });
      expect(id).toBe('ollama-llama3:8b');
    });
  });

  describe('_poll', () => {
    let mockServer;
    let serverPort;

    beforeAll((done) => {
      mockServer = http.createServer((req, res) => {
        if (mockServer._handler) {
          mockServer._handler(req, res);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: [] }));
        }
      });
      mockServer.listen(0, '127.0.0.1', () => {
        serverPort = mockServer.address().port;
        done();
      });
    });

    afterAll((done) => {
      mockServer.close(done);
    });

    function createScannerWithPort(port) {
      const s = new OllamaScanner(agentManager, debugLog);
      // Override _fetch to hit our test server
      s._fetch = function (path) {
        return new Promise((resolve) => {
          const req = http.get(
            { hostname: '127.0.0.1', port, path, timeout: 3000 },
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
      };
      return s;
    }

    test('registers model as agent when Ollama returns models', async () => {
      const model = makeModel('qwen3:8b', { paramSize: '8.2B' });
      mockServer._handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [model] }));
      };

      const s = createScannerWithPort(serverPort);
      await s._poll();

      expect(agentManager.updateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: expect.stringContaining('ollama-'),
          displayName: 'qwen3:8b (8.2B)',
          state: 'Waiting',
          model: 'qwen3:8b',
          isOllama: true,
        }),
        'ollama'
      );
    });

    test('strips :latest from display name', async () => {
      const model = makeModel('llama3:latest');
      mockServer._handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [model] }));
      };

      const s = createScannerWithPort(serverPort);
      await s._poll();

      expect(agentManager.updateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'llama3 (8B)' }),
        'ollama'
      );
    });

    test('detects activity when expires_at changes between polls', async () => {
      const model1 = makeModel('qwen3:8b', { expiresAt: '2026-03-12T12:00:00Z' });
      mockServer._handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [model1] }));
      };

      const s = createScannerWithPort(serverPort);
      await s._poll();

      expect(agentManager.updateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'Waiting' }),
        'ollama'
      );

      agentManager.updateAgent.mockClear();

      const model2 = makeModel('qwen3:8b', { expiresAt: '2026-03-12T12:05:00Z' });
      mockServer._handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [model2] }));
      };

      await s._poll();

      expect(agentManager.updateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'Working', currentTool: 'generate' }),
        'ollama'
      );
    });

    test('removes agent when model disappears from /api/ps', async () => {
      const model = makeModel('qwen3:8b');
      mockServer._handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [model] }));
      };

      const s = createScannerWithPort(serverPort);
      await s._poll();
      expect(agentManager.updateAgent).toHaveBeenCalled();

      mockServer._handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
      };

      await s._poll();
      expect(agentManager.removeAgent).toHaveBeenCalled();
    });

    test('removes all agents when Ollama goes offline', async () => {
      const model = makeModel('qwen3:8b');
      mockServer._handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [model] }));
      };

      const s = createScannerWithPort(serverPort);
      await s._poll();
      expect(s.ollamaAvailable).toBe(true);

      mockServer._handler = (req, res) => {
        res.writeHead(500);
        res.end();
      };

      await s._poll();
      expect(s.ollamaAvailable).toBe(false);
      expect(agentManager.removeAgent).toHaveBeenCalled();
      expect(s.trackedModels.size).toBe(0);
    });

    test('handles Ollama not running (connection refused)', async () => {
      const s = createScannerWithPort(59999); // nothing listens here
      await s._poll();
      expect(s.ollamaAvailable).toBe(false);
      expect(agentManager.updateAgent).not.toHaveBeenCalled();
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
      scanner.trackedModels.set('ollama-a', { expiresAt: null, model: {} });
      scanner.trackedModels.set('ollama-b', { expiresAt: null, model: {} });

      scanner._removeAllTracked();

      expect(agentManager.removeAgent).toHaveBeenCalledTimes(2);
      expect(scanner.trackedModels.size).toBe(0);
    });
  });
});

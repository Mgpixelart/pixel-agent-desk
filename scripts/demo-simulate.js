/**
 * Demo Simulation Script
 * Sends fake hook events to populate the office with agents for GIF recording.
 *
 * Usage:
 *   1. npm start  (app must be running)
 *   2. node scripts/demo-simulate.js
 */

'use strict';

const http = require('http');

const HOOK_URL = 'http://127.0.0.1:47821/hook';

function sendHook(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(HOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Agent Scenarios ───

const agents = [
  { id: 'demo-agent-1', cwd: '/projects/pixel-agent-desk', model: 'claude-opus-4-6' },
  { id: 'demo-agent-2', cwd: '/projects/web-app', model: 'claude-sonnet-4-6' },
  { id: 'demo-agent-3', cwd: '/projects/api-server', model: 'claude-sonnet-4-6' },
  { id: 'demo-agent-4', cwd: '/projects/ml-pipeline', model: 'claude-haiku-4-5' },
];

const tools = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebSearch'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randTokens(base) { return base + Math.floor(Math.random() * base * 0.5); }

async function simulateAgent(agent, delayOffset) {
  await sleep(delayOffset);

  const ts = () => Date.now();

  // 1. SessionStart
  console.log(`[${agent.id}] SessionStart`);
  await sendHook({
    hook_event_name: 'SessionStart',
    session_id: agent.id,
    cwd: agent.cwd,
    model: agent.model,
    _pid: 99900 + Math.floor(Math.random() * 100),
    _timestamp: ts(),
  });
  await sleep(1500);

  // 2. UserPromptSubmit → Thinking
  console.log(`[${agent.id}] UserPromptSubmit`);
  await sendHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: agent.id,
    _timestamp: ts(),
  });
  await sleep(2000);

  // 3. First PreToolUse (ignored for state)
  await sendHook({
    hook_event_name: 'PreToolUse',
    session_id: agent.id,
    tool_name: 'Read',
    tool_input: { file_path: '/src/main.js' },
    _timestamp: ts(),
  });
  await sleep(800);

  // 4. Work cycle: alternate between tools
  let cumInput = 0, cumOutput = 0;
  const cycles = 5 + Math.floor(Math.random() * 4);

  for (let i = 0; i < cycles; i++) {
    const tool = pick(tools);
    cumInput += randTokens(3000);
    cumOutput += randTokens(800);

    // PreToolUse → Working
    console.log(`[${agent.id}] Working: ${tool} (${i + 1}/${cycles})`);
    await sendHook({
      hook_event_name: 'PreToolUse',
      session_id: agent.id,
      tool_name: tool,
      tool_input: { command: `demo-${tool.toLowerCase()}` },
      _timestamp: ts(),
    });
    await sleep(1500 + Math.random() * 2500);

    // PostToolUse → Thinking (with token accumulation)
    await sendHook({
      hook_event_name: 'PostToolUse',
      session_id: agent.id,
      tool_name: tool,
      tool_input: { command: `demo-${tool.toLowerCase()}` },
      tool_response: {
        output: 'ok',
        token_usage: {
          input_tokens: cumInput,
          output_tokens: cumOutput,
          cache_read_tokens: Math.floor(cumInput * 0.3),
          cache_creation_tokens: 0,
        },
      },
      _timestamp: ts(),
    });
    await sleep(1000 + Math.random() * 1500);
  }

  // 5. Done
  console.log(`[${agent.id}] Stop (Done)`);
  await sendHook({
    hook_event_name: 'Stop',
    session_id: agent.id,
    last_assistant_message: 'Task completed successfully.',
    _timestamp: ts(),
  });
}

async function main() {
  console.log('=== Demo Simulation Start ===');
  console.log('Make sure the app is running (npm start)\n');

  try {
    // Test connection
    await sendHook({
      hook_event_name: 'SessionStart',
      session_id: '__test__',
      cwd: '/tmp/test',
      _timestamp: Date.now(),
    });
    // Clean up test
    await sendHook({
      hook_event_name: 'SessionEnd',
      session_id: '__test__',
      _timestamp: Date.now(),
    });
  } catch (e) {
    console.error('Cannot connect to hook server. Is the app running? (npm start)');
    process.exit(1);
  }

  console.log('Connected to hook server.\n');

  // Launch agents with staggered start
  const promises = agents.map((ag, i) => simulateAgent(ag, i * 2000));
  await Promise.all(promises);

  console.log('\n=== All agents done. Waiting 8s before cleanup... ===');
  await sleep(8000);

  // SessionEnd cleanup
  for (const ag of agents) {
    await sendHook({
      hook_event_name: 'SessionEnd',
      session_id: ag.id,
      _timestamp: Date.now(),
    });
  }

  console.log('=== Demo complete. ===');
}

main().catch(console.error);

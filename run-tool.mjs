#!/usr/bin/env node

/**
 * Thin CLI bridge — spawned by the Tauri Rust backend for each tool call.
 *
 * Usage: node run-tool.mjs <toolName> '<jsonParams>'
 *
 * Reads runtime tokens from config.json, refreshes if expired, then invokes
 * the tool. All configuration is self-contained — the host only sets cwd.
 */

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import gmailPlugin, { resolveAuth, refreshTokenIfExpired } from './dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fail(error) {
  console.log(JSON.stringify({ success: false, error }));
  process.exit(0);
}

const toolName = process.argv[2];
const paramsJson = process.argv[3] || '{}';

if (!toolName) fail('Usage: run-tool.mjs <toolName> <jsonParams>');

let params;
try { params = JSON.parse(paramsJson); } catch {
  fail(`Invalid JSON params: ${paramsJson}`);
}

const { username, accessToken: rawToken, config, configPath } = resolveAuth(__dirname);

// gmail_authorize handles its own token acquisition — skip refresh to avoid
// blocking on potentially invalid/expired tokens before the OAuth flow starts.
const isAuthTool = toolName === 'gmail_authorize';
const accessToken = isAuthTool
  ? rawToken
  : await refreshTokenIfExpired({ accessToken: rawToken, config, configPath });

const tools = {};
const mockApi = {
  registerTool(def) { tools[def.name] = def; },
  get pluginConfig() { return { username, accessToken, requireExplicitSendConfirmation: true }; },
};

await gmailPlugin.register(mockApi);

const tool = tools[toolName];
if (!tool) {
  fail(`Unknown gmail tool: ${toolName}. Available: ${Object.keys(tools).join(', ')}`);
}

try {
  const result = await tool.execute(`req-${Date.now()}`, params);
  console.log(JSON.stringify({ success: true, data: result }));
  // Explicit exit to ensure the process terminates promptly even if the
  // tool left lingering handles (HTTP server sockets, timers, etc.).
  setImmediate(() => process.exit(0));
} catch (error) {
  fail(error instanceof Error ? error.message : 'Gmail plugin execution failed');
}

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function safeToolDiagnostic(result) {
  const text = (result?.content || []).filter(block => block.type === 'text').map(block => block.text).join(' ');
  // MCP never receives server/provider keys from this worker. Also scrub key-
  // shaped strings and local user paths from diagnostics before surfacing them.
  return text.replace(/(?:sk-[a-z0-9-]*[a-z0-9]{12,}|Bearer\s+[^\s"']+|\b[a-f0-9]{64}\b)/gi, '[redacted]')
    .replace(/[a-z]:[\\/]Users[\\/][^\s"']+/gi, '[local path]')
    .replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').slice(0, 280);
}

// Studio's official stdio server uses one JSON-RPC message per line. Never pass
// the worker's server credential (or other API keys) to its child process.
function studioEnvironment(env = process.env) {
  const allowed = new Set(['systemroot', 'windir', 'comspec', 'path', 'pathext', 'localappdata', 'appdata', 'userprofile', 'home', 'temp', 'tmp', 'lang']);
  return Object.fromEntries(Object.entries(env).filter(([name]) => allowed.has(name.toLowerCase())));
}
function resolveStudioExecutable({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') {
    const executable = '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP';
    if (!fs.existsSync(executable)) throw new Error('Install Roblox Studio and enable its MCP server first');
    return executable;
  }
  if (platform !== 'win32' || !env.LOCALAPPDATA) throw new Error('The Studio worker requires Windows or macOS with Roblox Studio installed');
  const base = path.resolve(env.LOCALAPPDATA, 'Roblox');
  const launcher = path.join(base, 'mcp.bat');
  if (!fs.existsSync(launcher)) throw new Error('Studio mcp.bat is missing; enable Studio as an MCP server first');
  const launcherText = fs.readFileSync(launcher, 'utf8');
  // Resolve only the installed executable advertised by Roblox's own launcher.
  // Avoid a shell wrapper and its extra child process, so shutdown kills the
  // actual MCP server. Never execute arbitrary text from the launcher.
  const match = launcherText.match(/if exist\s+"([^"\r\n]+StudioMCP\.exe)"/i);
  if (!match) throw new Error('Studio MCP launcher format is unsupported; update Roblox Studio');
  const executable = path.resolve(match[1]);
  const relative = path.relative(base, executable);
  if (relative.startsWith('..') || path.isAbsolute(relative) || path.basename(executable).toLowerCase() !== 'studiomcp.exe' || !fs.existsSync(executable)) throw new Error('Studio MCP executable must be inside the installed Roblox directory');
  return executable;
}

class StudioMcpClient {
  constructor({ process: child, timeoutMs = 30000, maxBytes = 8 * 1024 * 1024 } = {}) {
    if (!child?.stdin || !child?.stdout) throw new Error('A stdio process is required');
    this.child = child; this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
    this.pending = new Map(); this.sequence = 0; this.buffer = ''; this.closed = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.receive(chunk));
    child.stdout.on('error', () => this.close(new Error('Studio MCP output failed')));
    child.stdin.on('error', () => this.close(new Error('Studio MCP input failed')));
    child.on('error', () => this.close(new Error('Could not start Studio MCP')));
    child.on('exit', () => this.close(new Error('Studio MCP disconnected')));
    // Drain stderr without logging arbitrary Studio output or private paths.
    child.stderr?.on('data', () => {});
  }
  receive(chunk) {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.maxBytes) return this.close(new Error('Studio MCP response exceeded its size limit'));
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { return this.close(new Error('Studio MCP returned invalid JSON')); }
      if (message.jsonrpc !== '2.0') return this.close(new Error('Studio MCP returned an invalid RPC message'));
      if (message.method) {
        if (message.id != null) this.write({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Client method unavailable' } }) });
        continue;
      }
      const waiting = this.pending.get(message.id);
      if (!waiting) continue;
      this.pending.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(`Studio MCP request failed (${Number(message.error.code) || -1})`));
      else waiting.resolve(message.result);
    }
  }
  write(message) {
    if (this.closed) throw new Error('Studio MCP is closed');
    const encoded = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(encoded) > this.maxBytes) throw new Error('Studio MCP request exceeded its size limit');
    this.child.stdin.write(encoded);
  }
  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('Studio MCP is closed'));
    if (this.pending.size >= 32) return Promise.reject(new Error('Studio MCP request limit reached'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('Studio MCP timed out; worker stopped to avoid repeating an uncertain mutation')), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    const result = await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'parallax-studio-worker', version: '1.0.0' } });
    if (!result?.protocolVersion) throw new Error('Studio MCP did not initialize');
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools = []; let cursor; let pages = 0;
    do {
      if (++pages > 10) throw new Error('Studio MCP tool pagination exceeded its limit');
      const page = await this.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(page?.tools)) throw new Error('Studio MCP did not return its tools');
      tools.push(...page.tools); cursor = page.nextCursor;
      if (tools.length > 300) throw new Error('Studio MCP tool list exceeded its limit');
    } while (cursor);
    this.tools = new Set(tools.map(tool => tool.name)); return this;
  }
  async call(name, args) {
    if (!this.tools?.has(name)) throw new Error(`Studio MCP tool is unavailable: ${name}`);
    const result = await this.request('tools/call', { name, arguments: args });
    if (result?.isError) throw new Error(`Studio tool ${name} could not complete the operation${safeToolDiagnostic(result) ? ': ' + safeToolDiagnostic(result) : ''}`);
    return result;
  }
  close(error = new Error('Studio MCP closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.pending.clear(); this.buffer = '';
    this.child.stdin.destroy?.(); this.child.kill?.();
  }
}
async function connectStudioMcp(options = {}) {
  const executable = resolveStudioExecutable(options);
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: studioEnvironment(options.env) });
  const client = new StudioMcpClient({ process: child });
  try { return await client.initialize(); } catch (error) { client.close(); throw error; }
}
module.exports = { StudioMcpClient, connectStudioMcp, resolveStudioExecutable, studioEnvironment, safeToolDiagnostic };

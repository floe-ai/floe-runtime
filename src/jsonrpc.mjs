// Generic newline-delimited JSON-RPC 2.0 transport over a child process's
// stdio. This module knows nothing about Codex or Copilot semantics - it only
// frames/parses messages, correlates request/response by id, and lets the
// owner (a Runtime adapter) react to inbound requests and notifications.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';
import { RuntimeFault, redact } from './errors.mjs';

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const WIN32 = process.platform === 'win32';
const CMD_META_CHARS = /[()%!^"<>&|;, ]/;

/**
 * Resolves a bare command name (e.g. "copilot") against PATH the way a shell
 * would, honouring PATHEXT on win32. Node's child_process.spawn() does
 * neither of these on its own: it will not search PATHEXT, so a CLI that is
 * only installed as `copilot.cmd`/`copilot.ps1` (as npm-installed bins are on
 * Windows - there is rarely a `copilot.exe`) fails with ENOENT even though
 * running `copilot` in a real shell works fine. Absolute/relative paths and
 * commands that already carry a recognized extension are used as-is.
 * Returns { file, needsShellWrapper } - needsShellWrapper is true only for
 * .bat/.cmd files, which CreateProcess cannot execute directly.
 */
export function resolveExecutable(command, env = process.env) {
  if (!WIN32) return { file: command, needsShellWrapper: false };
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasSep = command.includes('/') || command.includes('\\');
  const alreadyHasExt = exts.some(ext => command.toLowerCase().endsWith(ext.toLowerCase()));
  const candidates = [];
  if (hasSep || alreadyHasExt) {
    candidates.push(command);
    if (!alreadyHasExt) for (const ext of exts) candidates.push(command + ext);
  } else {
    const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      for (const ext of exts) candidates.push(path.join(dir, command + ext));
      candidates.push(path.join(dir, command)); // extensionless shims (e.g. npm's posix-style launcher) last
    }
  }
  const resolved = candidates.find(candidate => existsSync(candidate));
  const file = resolved || command; // fall back to the bare name, letting spawn() fail naturally with ENOENT
  const ext = path.extname(file).toLowerCase();
  return { file, needsShellWrapper: ext === '.cmd' || ext === '.bat' };
}

/**
 * Quotes a single argument for the cmd.exe wrapper invocation used for
 * .bat/.cmd shims (see resolveExecutable). This mirrors the well-known
 * CreateProcess/cmd.exe quoting rules (the same ones Node's own shell:true
 * path and the `cross-spawn` package use) but is applied ONLY to this
 * explicit wrapper invocation, never to a native .exe spawn - so normal
 * argument passing never goes through shell parsing at all.
 */
function quoteCmdArg(arg) {
  const value = String(arg);
  if (value === '') return '""';
  if (!CMD_META_CHARS.test(value)) return value;
  return '"' + value.replace(/"/g, '""') + '"';
}

/**
 * Events emitted:
 *  - 'request'      (message)         inbound JSON-RPC request from the subprocess (has id + method)
 *  - 'notification'  (message)        inbound JSON-RPC notification (has method, no id)
 *  - 'diagnostic'    (text)           redacted stderr output or protocol warnings
 *  - 'exit'          (code, signal)   subprocess exited
 *  - 'error'         (error)          subprocess failed to spawn
 */
export class JsonRpcPeer extends EventEmitter {
  constructor({ command, args = [], env = process.env, unavailableCode = 'runtime_unavailable' } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.unavailableCode = unavailableCode;
    this.process = null;
    this.pending = new Map();
    this.awaitingResponse = new Set();
    this.serial = 0;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }

  /** Spawns the subprocess. Must be called once before request()/notify() will work. */
  spawn() {
    const { file, needsShellWrapper } = resolveExecutable(this.command, this.env);
    const proc = needsShellWrapper
      ? spawn(this.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', quoteCmdArg(file), ...this.args.map(quoteCmdArg)],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true, env: this.env })
      : spawn(file, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env });
    this.process = proc;
    proc.stdout.on('data', chunk => this.#onData(chunk));
    proc.stderr.on('data', chunk => this.emit('diagnostic', redact(chunk.toString())));
    proc.on('error', error => this.emit('error', error));
    proc.on('exit', (code, signal) => this.emit('exit', code, signal));
    return proc;
  }

  #onData(chunk) {
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.emit('error', new Error('Subprocess emitted an oversized protocol frame.'));
      this.process?.kill();
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch (error) { this.emit('diagnostic', 'Invalid protocol message: ' + error.message); continue; }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message.id !== undefined && !message.method) {
      // A response to one of our own requests.
      const key = String(message.id);
      const request = this.pending.get(key);
      if (!request) return;
      this.pending.delete(key);
      clearTimeout(request.timer);
      if (message.error) request.reject(new RuntimeFault('rpc_error', message.error.message || 'The subprocess rejected the request.', 502));
      else request.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.awaitingResponse.add(String(message.id));
      this.emit('request', message);
      return;
    }
    this.emit('notification', message);
  }

  /** Sends a JSON-RPC request and resolves/rejects with the correlated response. */
  request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin.writable) {
        reject(new RuntimeFault(this.unavailableCode, `${this.command} is unavailable.`, 503));
        return;
      }
      const requestId = String(++this.serial);
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RuntimeFault('rpc_timeout', `${method} did not acknowledge in time. Its outcome may be unknown.`, 504));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
      });
    });
  }

  /** Sends a one-way JSON-RPC notification (no response expected). */
  notify(method, params) {
    this.process?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** Responds to an inbound server-initiated request (from `request` events) with a result. */
  respond(requestId, result) {
    this.awaitingResponse.delete(String(requestId));
    this.process?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, result }) + '\n');
  }

  /** Responds to an inbound server-initiated request with an error. */
  respondError(requestId, message, code = -32000) {
    this.awaitingResponse.delete(String(requestId));
    this.process?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, error: { code, message } }) + '\n');
  }

  /** True while an inbound request from the subprocess is still waiting for respond()/respondError(). */
  isAwaitingResponse(requestId) {
    return this.awaitingResponse.has(String(requestId));
  }

  /** Rejects all pending requests (used when the connection is lost) and resets buffering state. */
  reset(error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.awaitingResponse.clear();
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }

  /** Gracefully terminates the subprocess, escalating to SIGKILL after `graceMs`. */
  async terminate(graceMs = 3000) {
    const proc = this.process;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, graceMs);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
      proc.kill('SIGTERM');
    });
  }
}

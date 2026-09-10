import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable } from '../src/jsonrpc.mjs';
import { JsonRpcPeer } from '../src/jsonrpc.mjs';

const isWin32 = process.platform === 'win32';

test('resolveExecutable finds a .cmd shim on PATH via PATHEXT (win32 only)', { skip: !isWin32 }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'floe-runtime-'));
  writeFileSync(path.join(dir, 'fake-cli.cmd'), '@echo off\r\necho hello\r\n');
  const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const { file, needsShellWrapper } = resolveExecutable('fake-cli', env);
  assert.equal(file.toLowerCase(), path.join(dir, 'fake-cli.cmd').toLowerCase());
  assert.equal(needsShellWrapper, true);
});

test('resolveExecutable leaves an already-extensioned or absolute command untouched (win32 only)', { skip: !isWin32 }, () => {
  const { file, needsShellWrapper } = resolveExecutable('C:\\Windows\\System32\\cmd.exe', {});
  assert.equal(file, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(needsShellWrapper, false);
});

test('a .cmd shim spawned via JsonRpcPeer actually runs and produces output (win32 only)', { skip: !isWin32 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'floe-runtime-'));
  writeFileSync(path.join(dir, 'fake-cli.cmd'), `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify({id:1,result:{ok:true}}))"\r\n`);
  const peer = new JsonRpcPeer({ command: 'fake-cli', args: [], env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH } });
  const exited = new Promise(resolve => peer.once('exit', resolve));
  peer.spawn();
  await exited;
});

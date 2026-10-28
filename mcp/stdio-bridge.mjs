#!/usr/bin/env node
// Ponte MCP stdio → HTTP. Usada pelo Claude Desktop (e qualquer cliente MCP stdio).
// Repassa cada mensagem JSON-RPC para POST {GTD_URL}/mcp. Se o servidor local não estiver
// rodando, sobe-o em segundo plano automaticamente.
//
// Variáveis: GTD_URL (padrão http://127.0.0.1:4317), GTD_TOKEN (padrão: lido de data/config.json)
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.GTD_URL || 'http://127.0.0.1:4317').replace(/\/$/, '');
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE);

function token() {
  if (process.env.GTD_TOKEN) return process.env.GTD_TOKEN;
  const cfg = path.join(process.env.GTD_DATA || path.join(ROOT, 'data'), 'config.json');
  return existsSync(cfg) ? JSON.parse(readFileSync(cfg, 'utf8')).token : '';
}

let starting = null;
async function ensureServer() {
  if (!IS_LOCAL) return false;
  if (!starting) {
    starting = (async () => {
      const port = new URL(BASE).port || '4317';
      spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'index.mjs')], {
        cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, PORT: port },
      }).unref();
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 250));
        try { if ((await fetch(BASE + '/health')).ok) return true; } catch { /* aguardando */ }
      }
      return false;
    })().finally(() => { setTimeout(() => { starting = null; }, 5000); });
  }
  return starting;
}

async function forward(line) {
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token()}` }, body: line };
  try { return await fetch(BASE + '/mcp', opts); }
  catch (e) {
    if (await ensureServer()) return fetch(BASE + '/mcp', { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token()}` } });
    throw e;
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    const res = await forward(line);
    if (res.status === 202) return;
    const text = (await res.text()).trim();
    if (!text) return;
    if (!res.ok && !text.startsWith('{"jsonrpc"')) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    process.stdout.write(text.replace(/\r?\n/g, ' ') + '\n');
  } catch (e) {
    if (msg.id === undefined || msg.id === null) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000,
      message: `GTD inacessível em ${BASE}: ${e.message}. Rode "npm start" em ${ROOT}.` } }) + '\n');
  }
});

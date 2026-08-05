// 幂等存储：JSON 文件持久化（单实例足够；多实例请替换为 Redis SETNX / 数据库唯一键）
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let state = { processed: {} }; // idempotency_key -> { at, reference }
let dirty = false;

function load() {
  try {
    fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
    if (fs.existsSync(config.stateFile)) {
      state = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
      if (!state.processed) state.processed = {};
    }
  } catch (err) {
    console.warn('[store] 状态文件读取失败，从空状态开始:', err.message);
  }
}

function persist() {
  if (!dirty) return;
  try {
    const tmp = `${config.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, config.stateFile);
    dirty = false;
  } catch (err) {
    console.error('[store] 持久化失败:', err.message);
  }
}

export function initStore() {
  load();
  setInterval(persist, 1000).unref();
}

export function isDuplicate(idempotencyKey) {
  return Boolean(state.processed[idempotencyKey]);
}

export function markProcessed(idempotencyKey, reference) {
  state.processed[idempotencyKey] = { at: new Date().toISOString(), reference };
  dirty = true;
}

export function processedCount() {
  return Object.keys(state.processed).length;
}


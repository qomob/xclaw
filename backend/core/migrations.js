// 轻量数据库迁移运行器
// 按文件名顺序执行 backend/migrations/*.sql，记录已应用迁移于 schema_migrations 表
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPostgres } from './dependencies.js';
import logger from '../services/loggerService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

/**
 * 运行所有未应用的迁移
 * 每个文件应使用幂等 DDL（IF NOT EXISTS），失败时抛出并终止启动
 */
export async function runMigrations() {
  const pool = getPostgres();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map(r => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      logger.info(`[Migrations] Applied ${file}`);
    } catch (err) {
      logger.error(`[Migrations] Failed to apply ${file}`, { error: err.message });
      throw err;
    }
  }
}


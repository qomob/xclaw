// 轻量数据库迁移运行器
// 按文件名顺序执行 backend/migrations/*.sql，记录已应用迁移于 schema_migrations 表
//
// 特性：
//   - 校验和：记录每个迁移文件的 sha256；已应用文件被改动时告警（MIGRATION_STRICT=true 时终止启动），
//     避免"改了已应用的迁移但线上从未生效"的静默漂移
//   - 回滚：可选 `NNN_name.down.sql` 伴生文件承载回滚 DDL，通过 `npm run migrate:down` 执行
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getPostgres } from './dependencies.js';
import logger from '../services/loggerService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');
const STRICT_CHECKSUM = process.env.MIGRATION_STRICT === 'true';

function checksumOf(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
}

async function ensureMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum VARCHAR(64)');
}

/**
 * 运行所有未应用的迁移
 * 每个文件应使用幂等 DDL（IF NOT EXISTS），失败时抛出并终止启动
 */
export async function runMigrations() {
  const pool = getPostgres();
  await ensureMigrationsTable(pool);

  const files = migrationFiles();
  const { rows } = await pool.query('SELECT name, checksum FROM schema_migrations');
  const applied = new Map(rows.map(r => [r.name, r.checksum]));

  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const checksum = checksumOf(filePath);

    if (applied.has(file)) {
      const recorded = applied.get(file);
      if (recorded && recorded !== checksum) {
        const message = `[Migrations] ${file} 已在线上应用，但文件内容已变更（checksum 不一致）——` +
          '结构性变更请新增迁移文件，不要修改历史迁移';
        if (STRICT_CHECKSUM) {
          logger.error(message);
          throw new Error(message);
        }
        logger.warn(message);
      }
      continue;
    }

    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await pool.query(sql);
      await pool.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum',
        [file, checksum]
      );
      logger.info(`[Migrations] Applied ${file}`);
    } catch (err) {
      logger.error(`[Migrations] Failed to apply ${file}`, { error: err.message });
      throw err;
    }
  }
}

/**
 * 回滚最近 N 个迁移（仅限带 `.down.sql` 伴生文件的迁移）。
 * 返回实际回滚的迁移名列表；无伴生文件时抛出，提示改用备份恢复。
 */
export async function rollbackMigrations(steps = 1) {
  const pool = getPostgres();
  await ensureMigrationsTable(pool);

  const { rows } = await pool.query(
    'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT $1',
    [steps]
  );
  if (rows.length === 0) return [];

  const rolledBack = [];
  for (const { name } of rows) {
    const downFile = path.join(MIGRATIONS_DIR, name.replace(/\.sql$/, '.down.sql'));
    if (!fs.existsSync(downFile)) {
      throw new Error(
        `迁移 ${name} 没有对应的 .down.sql 回滚脚本；请改用备份恢复（docs/backup-restore.md）或手工编写回滚 DDL`
      );
    }
    const sql = fs.readFileSync(downFile, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
      await client.query('COMMIT');
      rolledBack.push(name);
      logger.info(`[Migrations] Rolled back ${name}`);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      logger.error(`[Migrations] Failed to roll back ${name}`, { error: err.message });
      throw err;
    } finally {
      client.release();
    }
  }
  return rolledBack;
}

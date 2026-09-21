// 迁移 CLI：
//   node scripts/migrate.js            # 应用全部未执行的迁移（等价于服务启动行为）
//   node scripts/migrate.js --down 1   # 回滚最近 1 个迁移（需要 NNN_name.down.sql 伴生文件）
//   npm run migrate:down -- 1
import { initPostgres, closeConnections } from '../core/dependencies.js';
import { runMigrations, rollbackMigrations } from '../core/migrations.js';
import logger from '../services/loggerService.js';

const args = process.argv.slice(2);
const downIdx = args.indexOf('--down');

async function main() {
  await initPostgres();

  if (downIdx !== -1) {
    const steps = Math.max(1, parseInt(args[downIdx + 1]) || 1);
    const rolled = await rollbackMigrations(steps);
    if (rolled.length === 0) {
      console.log('没有可回滚的迁移（schema_migrations 为空）');
    } else {
      console.log(`已回滚: ${rolled.join(', ')}`);
    }
  } else {
    await runMigrations();
    console.log('迁移已执行到最新');
  }
}

main()
  .then(async () => {
    await closeConnections();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error('[Migrations] CLI failed', { error: err.message });
    console.error(`迁移失败: ${err.message}`);
    await closeConnections().catch(() => {});
    process.exit(1);
  });

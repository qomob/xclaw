// 单测统一清理钩子：关闭测试期间建立的真实连接（Redis / PostgreSQL）。
//
// 背景：cacheService / concurrency 两个套件使用真实 Redis，此前只清理缓存键、
// 不关闭连接。在 --runInBand（CI 使用的模式）下测试运行在主进程，未释放的
// socket 句柄会让 jest 永不退出——CI 步骤挂起到 job 超时（历史上烧过 6 小时）。
// 这里作为所有单测套件的收尾钩子统一关闭；mock 了 dependencies.js 的套件
// 没有真实连接，closeConnections 不存在，直接跳过。
import { afterAll } from '@jest/globals';

afterAll(async () => {
  try {
    const deps = await import('../../core/dependencies.js');
    if (typeof deps.closeConnections === 'function') {
      await deps.closeConnections();
    }
  } catch {
    /* dependencies 被 mock（无真实连接）或导入失败：忽略 */
  }
});

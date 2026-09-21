export default {
  transform: {},
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transformIgnorePatterns: [
    'node_modules/(?!(uuid)/)'
  ],
  // 统一资源清理：关闭测试中建立的真实 Redis/PG 连接，
  // 否则 --runInBand 下未释放的句柄会让 jest 无法退出（CI 曾挂起 6 小时）
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup/closeConnections.js']
};

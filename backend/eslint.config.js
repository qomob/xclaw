// 后端 ESLint 扁平配置（Node ESM）。
// 目标：捕获真实缺陷（未定义变量、未使用变量、不可达代码），不做风格格式化。
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'logs/**', 'data/**', '__tests__/**', 'scripts/legacy/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // 未使用变量：允许以 _ 开头的占位参数（catch (_) {} 等惯用法）
      // 未使用变量/导入：历史遗留较多，先作为告警（不可作为门槛），逐步清理
      'no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      // 允许 console：CLI 脚本与启动期 FATAL 输出依赖它
      'no-console': 'off',
      // 风格类（不影响正确性）降级为告警
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'preserve-caught-error': 'off',
      'no-constant-binary-expression': 'warn',
    },
  },
];

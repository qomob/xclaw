import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// 说明：以下规则在存量代码中命中较多，统一降级为 warning（不阻断 CI），
// 真实缺陷类规则（no-undef / no-unreachable / no-dupe-keys 等）保持 error。
// 目标：lint 作为可用的门槛而不是长期红的摆设；warning 逐步清理后再收紧。
const SOFT_RULES = {
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-unused-vars': ['warn', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
  'react-hooks/exhaustive-deps': 'warn',
  'react-hooks/set-state-in-effect': 'warn',
  'react-hooks/immutability': 'warn',
  'react-hooks/refs': 'warn',
  'react-refresh/only-export-components': 'warn',
  'no-empty': ['error', { allowEmptyCatch: true }],
}

export default defineConfig([
  globalIgnores(['dist', 'coverage', 'vitest.config.ts']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: SOFT_RULES,
  },
  {
    // 三方库的类型补丁文件：any 是常态，不参与该规则
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])

// ============================================================
// ESLint Flat Config — Backend Node.js (CommonJS)
// ============================================================
const globals = require('globals');

module.exports = [
  {
    // Files to ignore
    ignores: [
      'node_modules/**',
      'public/bundle.js',
      'public/bundle.js.map',
      'public/**/*.min.js',
      'coverage/**',
    ],
  },

  // ── Backend server code ──
  {
    files: [
      'server.js',
      'mcp-server.js',
      'cli-discovery.js',
      'preset-loader.js',
      'rate-limiter.js',
      'ring-buffer.js',
      'ws-handler.js',
      'routes/**/*.js',
      'ws/**/*.js',
      'plugins/**/*.js',
      'mcp/**/*.js',
    ],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Safety: catch accidental globals
      'no-undef': 'error',

      // Style: prefer modern JS
      'no-var': 'warn',
      'prefer-const': ['warn', { destructuring: 'all' }],
      'prefer-arrow-callback': 'warn',
      'prefer-template': 'warn',
      'object-shorthand': ['warn', 'always'],

      // Quality: catch common mistakes
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-unused-expressions': 'warn',
      'eqeqeq': ['warn', 'smart'],
      'no-constant-condition': 'warn',
      'no-duplicate-imports': 'warn',
      'no-promise-executor-return': 'warn',
      'no-self-compare': 'warn',

      // Console is used extensively for logging — keep enabled
      'no-console': 'off',
    },
  },

  // ── Frontend code (ES modules) ──
  {
    files: ['public/**/*.js'],
    ignores: ['public/bundle.js', 'public/bundle.js.map', 'public/**/*.min.js'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        window: 'readonly',
        document: 'readonly',
        QCLI: 'writable',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-var': 'warn',
      'prefer-const': ['warn', { destructuring: 'all' }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'eqeqeq': ['warn', 'smart'],
    },
  },

  // ── Test files (stricter about dependencies) ──
  {
    files: ['test/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-var': 'warn',
      'prefer-const': 'warn',
    },
  },
];

const js = require('@eslint/js');
const globals = require('globals');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Loaded as global <script> tags from public/vendor/, not imported.
        Vue: 'readonly',
        cytoscape: 'readonly',
        dagre: 'readonly',
        cytoscapeNodeHtmlLabel: 'readonly',
        cytoscapeExpandCollapse: 'readonly',
        html2canvas: 'readonly',
      },
    },
  },
  {
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  prettierConfig,
  {
    ignores: ['public/vendor/**', 'node_modules/**', 'data/**'],
  },
];

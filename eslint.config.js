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
    // Runs in Node like the rest of scripts/, but hands callbacks to playwright's page.evaluate(),
    // whose bodies are serialised and executed inside the browser - so it legitimately references
    // document/window alongside require and process. Both sets of globals apply here.
    files: ['scripts/screenshots.js'],
    languageOptions: {
      globals: { ...globals.browser },
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

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
  {
    // Everything the server logs goes through logger.js so it carries a [LEVEL] tag the Log
    // Viewer's level filters can see - a console.error/warn elsewhere in server/ is invisible to
    // it. logger.js itself is exempt since it's what console.log/warn/error actually funnel
    // through; index.js's two startup/shutdown banner lines are the only other exception and are
    // each marked with an eslint-disable-next-line instead of being carved out here, so a new
    // console call anywhere else in server/ is caught rather than silently allowed by a broad
    // file match.
    files: ['server/**/*.js'],
    ignores: ['server/logger.js'],
    rules: {
      'no-console': 'error',
    },
  },
  prettierConfig,
  {
    ignores: ['public/vendor/**', 'node_modules/**', 'data/**'],
  },
];

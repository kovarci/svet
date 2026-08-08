import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/**
 * Ce que le linter surveille, et ce qu'il laisse tranquille.
 *
 * Le code de ce dépôt suit une discipline qu'aucune règle automatique ne sait
 * vérifier — un commentaire qui dit *pourquoi*, une décision expliquée là où
 * elle est prise. Le linter n'est donc pas là pour imposer un style : il est là
 * pour attraper les fautes qu'une relecture ne voit pas. Une variable mal
 * orthographiée, une promesse non attendue, un `case` qui déborde sur le
 * suivant.
 *
 * `eslint-config-prettier` vient en dernier et éteint tout ce qui touche à la
 * mise en forme : c'est Prettier qui s'en charge, et deux outils qui se
 * disputent l'indentation ne rendent service à personne.
 */
export default [
  {
    ignores: [
      'node_modules/**',
      'web/dist/**',
      'web/public/data/**',
      'pipeline/cache/**',
      'pipeline/validation/**',
    ],
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // Une variable inutilisée est presque toujours le reste d'un
      // remaniement — sauf en tête d'argument, où elle sert à nommer la place
      // d'un paramètre qu'on ignore volontairement.
      // `ignoreRestSiblings` couvre l'idiome qui retire une clé d'un objet :
      // `const { delta, ...rest } = candidat` ne laisse pas `delta` inutilisée,
      // il dit précisément qu'on n'en veut pas.
      'no-unused-vars': [
        'error',
        { args: 'after-used', argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // `await` dans une boucle est parfois exactement ce qu'on veut : les
      // recherches de « quand partir ? » doivent s'enchaîner, pas se ruer.
      'no-await-in-loop': 'off',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
    },
  },

  {
    files: ['web/src/**/*.js', 'web/public/sw.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        // Ordonnanceur coopératif, encore absent de la liste `globals` : c'est
        // lui qui permet à la recherche d'itinéraire de rendre la main.
        scheduler: 'readonly',
      },
    },
  },

  {
    files: ['pipeline/**/*.js', 'pipeline/**/*.mjs', 'web/vite.config.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['**/test/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  prettier,
];

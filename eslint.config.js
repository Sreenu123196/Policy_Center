// ESLint checks the code for likely bugs and style problems without running it.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'policycenter-sim'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);

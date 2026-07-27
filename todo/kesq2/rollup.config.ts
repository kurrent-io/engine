import path from 'node:path';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';
import typescript from '@rollup/plugin-typescript';
import postcss from 'rollup-plugin-postcss';
import serve from 'rollup-plugin-serve';
import livereload from 'rollup-plugin-livereload';
import type { RollupOptions, WarningHandlerWithDefault } from 'rollup';

const isDev = process.env.ROLLUP_WATCH === 'true' || process.env.BUILD_MODE === 'dev';

const onwarn: WarningHandlerWithDefault = (warning, warn) => {
  if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
  if (warning.code === 'THIS_IS_UNDEFINED') return;
  warn(warning);
};

// The query server: bundles the generated registry (gen/server) with the
// real query implementations.  Bare imports stay external and resolve from
// node_modules at runtime.
const server: RollupOptions = {
  input: 'src/server/main.ts',
  output: {
    file: 'dist/server.js',
    format: 'esm',
    sourcemap: true,
  },
  external: (id, importer) =>
    importer !== undefined &&
    !id.startsWith('.') &&
    !id.startsWith('#') &&
    !path.isAbsolute(id),
  plugins: [
    resolve({
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    }),
    typescript({
      tsconfig: './tsconfig.json',
    }),
  ],
  onwarn,
};

// The browser bundle.  The 'browser' condition routes #queries/* imports to
// the client mirrors (gen/client), where flexible queries carry both a wire
// reference and their local implementation, and server-only queries are bare
// wire references.
const client: RollupOptions = {
  input: 'src/client/index.tsx',
  output: {
    file: 'dist/bundle.js',
    format: 'esm',
    sourcemap: true,
  },
  plugins: [
    replace({
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
      preventAssignment: true,
    }),
    resolve({
      browser: true,
      exportConditions: ['browser'],
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    }),
    commonjs(),
    postcss(),
    typescript({
      tsconfig: './tsconfig.json',
    }),
    isDev &&
      serve({
        open: true,
        contentBase: ['dist', 'public'],
        port: 3009,
      }),
    isDev && livereload('dist'),
  ],
  onwarn,
};

export default [server, client];

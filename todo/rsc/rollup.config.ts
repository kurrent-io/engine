import path from 'node:path';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';
import typescript from '@rollup/plugin-typescript';
import postcss from 'rollup-plugin-postcss';
import serve from 'rollup-plugin-serve';
import livereload from 'rollup-plugin-livereload';
import type { RollupOptions, WarningHandlerWithDefault } from 'rollup';

import rsc from './rsc-plugin';

const isDev = process.env.ROLLUP_WATCH === 'true' || process.env.BUILD_MODE === 'dev';

const onwarn: WarningHandlerWithDefault = (warning, warn) => {
  if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
  if (warning.code === 'THIS_IS_UNDEFINED') return;
  warn(warning);
};

// The flight server: runs in Node (with --conditions react-server, so react
// resolves to its server-component build).  Bare imports stay external and
// resolve from node_modules at runtime.
const server: RollupOptions = {
  input: 'src/server/main.tsx',
  output: {
    file: 'dist/server.js',
    format: 'esm',
    sourcemap: true,
  },
  external: (id, importer) =>
    importer !== undefined && !id.startsWith('.') && !path.isAbsolute(id),
  plugins: [
    resolve({
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    }),
    typescript({
      tsconfig: './tsconfig.json',
    }),
    rsc({ side: 'server' }),
  ],
  onwarn,
};

// The browser bundle: the flight client plus every 'use client' module.
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
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    }),
    commonjs(),
    postcss(),
    typescript({
      tsconfig: './tsconfig.json',
    }),
    rsc({ side: 'client', clientDir: 'src/client' }),
    isDev &&
      serve({
        open: true,
        contentBase: ['dist', 'public'],
        port: 3005,
      }),
    isDev && livereload('dist'),
  ],
  onwarn,
};

export default [server, client];

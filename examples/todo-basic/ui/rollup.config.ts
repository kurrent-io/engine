import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import livereload from 'rollup-plugin-livereload';
import serve from 'rollup-plugin-serve';
import url from '@rollup/plugin-url';
import postcss from 'rollup-plugin-postcss';
import esbuild, { minify } from 'rollup-plugin-esbuild';
import replace from '@rollup/plugin-replace';

const isDev = process.env.ROLLUP_WATCH === 'true' || process.env.BUILD_MODE === 'dev';

export default {
  input: 'src/index.tsx',
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
    url({
      limit: 0,                        // Always copy files instead of embedding them as base64 (since limit is 0)
      include: ['**/*.png'],           // Include these file types
      destDir: 'dist/assets'           // Destination folder for copied assets
    }),
    esbuild(),
    isDev && serve({
      open: true,
      contentBase: ['dist', 'public'],
      port: 3000,
    }),
    isDev && livereload('dist'),
    !isDev && minify(),
  ],
  onwarn: (warning, warn) => {
    // ignore a lot of errors coming from antd
    if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
    if (warning.code === "THIS_IS_UNDEFINED") return;
    warn(warning);
  },
};

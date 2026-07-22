import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import MagicString from 'magic-string';
import type { Plugin } from 'rollup';

/*
 * Minimal React Server Components bundler integration.
 *
 * RSC needs two builds of the same source tree, plus an agreement between
 * them about how client components are named:
 *
 * - The *server* build must not contain client component code.  Every module
 *   marked with a `'use client'` directive is replaced by a stub that exports
 *   a client reference (an opaque marker carrying "<module>#<export>") for
 *   each of the module's exports.  When the flight renderer encounters one of
 *   these in an element tree, it serializes the reference and the props
 *   instead of rendering it.
 *
 * - The *client* build must contain the real client component code, even
 *   though nothing in the browser entry imports it directly (client
 *   components are reachable only through references in flight payloads).
 *   The virtual module `rsc:client-modules` imports every `'use client'`
 *   module found under `clientDir`, and each such module gets code appended
 *   that registers its exports under the same module id the server stubs use.
 *   The registry is exposed through the `__webpack_require__` /
 *   `__webpack_chunk_load__` globals, which is the API the webpack flavor of
 *   the flight client resolves references through.  Everything lives in one
 *   bundle, so "chunk loading" is a no-op.
 *
 * Module ids are package-root-relative paths (e.g. "src/client/interactive.tsx"),
 * which keeps both sides in agreement without emitting a manifest file.
 *
 * Place this plugin *after* the typescript plugin: it detects the directive
 * by reading the original source from disk, but parses (and stubs or extends)
 * the compiled JS.
 */

const CLIENT_MODULES = 'rsc:client-modules';
const RUNTIME = 'rsc:runtime';
const RESOLVED: Record<string, string> = {
  [CLIENT_MODULES]: '\0' + CLIENT_MODULES,
  [RUNTIME]: '\0' + RUNTIME,
};

const SOURCE_EXT = /\.[jt]sx?$/;

// a 'use client' directive at the top of the module, allowing leading
// comments and whitespace
function hasDirective(source: string): boolean {
  let i = 0;
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i);
      if (nl === -1) return false;
      i = nl + 1;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return false;
      i = end + 2;
    } else {
      break;
    }
  }
  const rest = source.slice(i, i + 12);
  return rest === "'use client'" || rest === '"use client"';
}

function isClientModule(id: string): boolean {
  if (!SOURCE_EXT.test(id) || !path.isAbsolute(id) || id.includes('node_modules')) {
    return false;
  }
  let source: string;
  try {
    source = readFileSync(id, 'utf8');
  } catch {
    return false;
  }
  return hasDirective(source);
}

// the id shared by the server's client references and the client's registry
function moduleId(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/');
}

function findClientModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findClientModules(full));
    else if (isClientModule(full)) out.push(full);
  }
  return out.sort();
}

type EsNode = { type: string; [key: string]: any };

// [exported name, local binding] for every export of the module
function collectExports(program: EsNode, id: string): [string, string][] {
  const out: [string, string][] = [];
  for (const node of program.body as EsNode[]) {
    switch (node.type) {
      case 'ExportNamedDeclaration': {
        if (node.source) {
          throw new Error(`${id}: re-exports are not supported in client modules`);
        }
        const decl = node.declaration;
        if (decl?.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            if (d.id.type !== 'Identifier') {
              throw new Error(`${id}: destructuring exports are not supported in client modules`);
            }
            out.push([d.id.name, d.id.name]);
          }
        } else if (decl) {
          out.push([decl.id.name, decl.id.name]);
        }
        for (const spec of node.specifiers ?? []) {
          out.push([spec.exported.name ?? spec.exported.value, spec.local.name]);
        }
        break;
      }
      case 'ExportDefaultDeclaration': {
        const decl = node.declaration;
        const name = decl.id?.name ?? (decl.type === 'Identifier' ? decl.name : undefined);
        if (!name) {
          throw new Error(
            `${id}: anonymous default exports are not supported in client modules; ` +
              `name the function or class`,
          );
        }
        out.push(['default', name]);
        break;
      }
      case 'ExportAllDeclaration':
        throw new Error(`${id}: export * is not supported in client modules`);
    }
  }
  return out;
}

const RUNTIME_SOURCE = `
const modules = new Map();

export function registerClientModule(id, exports) {
  modules.set(id, exports);
}

// The flight client (webpack flavor) resolves client references through
// webpack's runtime API.  Everything is in one bundle, so module lookup is a
// map access and chunk loading is a no-op.
globalThis.__webpack_require__ = (id) => {
  const mod = modules.get(id);
  if (!mod) throw new Error('unregistered client module: ' + id);
  return mod;
};
globalThis.__webpack_chunk_load__ = () => Promise.resolve();
`;

export default function rsc(
  options: { side: 'server' } | { side: 'client'; clientDir: string },
): Plugin {
  return {
    name: 'rsc',

    resolveId(source) {
      if (source !== CLIENT_MODULES && source !== RUNTIME) return null;
      if (options.side !== 'client') {
        this.error(`${source} is only available in client builds`);
      }
      return RESOLVED[source];
    },

    load(id) {
      if (options.side !== 'client') return null;
      if (id === RESOLVED[RUNTIME]) {
        return RUNTIME_SOURCE;
      }
      if (id === RESOLVED[CLIENT_MODULES]) {
        const files = findClientModules(path.resolve(options.clientDir));
        if (files.length === 0) {
          this.warn(`no 'use client' modules found under ${options.clientDir}`);
        }
        return files.map((f) => `import ${JSON.stringify(f)};\n`).join('');
      }
      return null;
    },

    transform(code, id) {
      if (!isClientModule(id)) return null;
      const ref = moduleId(id);
      const exports = collectExports(this.parse(code) as unknown as EsNode, ref);

      if (options.side === 'server') {
        let out = `import { registerClientReference } from 'react-server-dom-webpack/server.edge';\n`;
        for (const [exported] of exports) {
          const stub =
            `registerClientReference(() => {\n` +
            `  throw new Error(${JSON.stringify(
              `${ref}#${exported} is a client component; it cannot be called on the server`,
            )});\n` +
            `}, ${JSON.stringify(ref)}, ${JSON.stringify(exported)})`;
          out +=
            exported === 'default'
              ? `export default ${stub};\n`
              : `export const ${exported} = ${stub};\n`;
        }
        return { code: out, map: { mappings: '' } };
      }

      const s = new MagicString(code);
      const entries = exports
        .map(([exported, local]) => `${JSON.stringify(exported)}: ${local}`)
        .join(', ');
      s.append(
        `\nimport { registerClientModule as __register } from ${JSON.stringify(RUNTIME)};\n` +
          `__register(${JSON.stringify(ref)}, { ${entries} });\n`,
      );
      return { code: s.toString(), map: s.generateMap({ hires: true }) };
    },
  };
}

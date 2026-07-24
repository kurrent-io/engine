import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'rollup';

/*
 * Bundler integration for KESQ — Kurrent Engine Server Queries.
 *
 * A module whose source begins with a `'use server'` directive contains
 * *server query factories*: plain functions that take serializable arguments
 * and return a framework query function.  The same import statement works in
 * both builds, but resolves to different things:
 *
 * - In the *server* build the module is included as-is, and the virtual
 *   module `kesq:queries` exports a registry mapping "<module>#<export>" to
 *   the factory, for every directive module found under `queryDir`.  The
 *   query server looks up incoming subscriptions in this registry.
 *
 * - In the *client* build the module is replaced by stubs: calling
 *   `listStats(id)` returns `{ $$kesq: "src/queries/server.ts#listStats",
 *   args: [id] }` instead of a query function.  Types still come from the
 *   real source, so call sites are identical either way; useQuery dispatches
 *   on the runtime shape — run the query locally, or subscribe to it over
 *   the websocket.
 *
 * Module ids are package-root-relative paths, which keeps the two sides in
 * agreement without emitting a manifest file.
 *
 * Place this plugin *after* the typescript plugin: it detects the directive
 * by reading the original source from disk, but parses the compiled JS.
 */

const REGISTRY = 'kesq:queries';
const RESOLVED_REGISTRY = '\0' + REGISTRY;

const SOURCE_EXT = /\.[jt]sx?$/;

// a 'use server' directive at the top of the module, allowing leading
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
  return rest === "'use server'" || rest === '"use server"';
}

function isQueryModule(id: string): boolean {
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

// the id shared by the client's stubs and the server's registry
function moduleId(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/');
}

function findQueryModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findQueryModules(full));
    else if (isQueryModule(full)) out.push(full);
  }
  return out.sort();
}

type EsNode = { type: string; [key: string]: any };

function collectExportNames(program: EsNode, id: string): string[] {
  const out: string[] = [];
  for (const node of program.body as EsNode[]) {
    switch (node.type) {
      case 'ExportNamedDeclaration': {
        const decl = node.declaration;
        if (decl?.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            if (d.id.type !== 'Identifier') {
              throw new Error(`${id}: destructuring exports are not supported in query modules`);
            }
            out.push(d.id.name);
          }
        } else if (decl) {
          out.push(decl.id.name);
        }
        for (const spec of node.specifiers ?? []) {
          out.push(spec.exported.name ?? spec.exported.value);
        }
        break;
      }
      case 'ExportDefaultDeclaration':
        out.push('default');
        break;
      case 'ExportAllDeclaration':
        throw new Error(`${id}: export * is not supported in query modules`);
    }
  }
  return out;
}

export default function kesq(
  options: { side: 'server'; queryDir: string } | { side: 'client' },
): Plugin {
  return {
    name: 'kesq',

    resolveId(source) {
      if (source !== REGISTRY) return null;
      if (options.side !== 'server') {
        this.error(`${REGISTRY} is only available in server builds`);
      }
      return RESOLVED_REGISTRY;
    },

    load(id) {
      if (id !== RESOLVED_REGISTRY || options.side !== 'server') return null;
      const files = findQueryModules(path.resolve(options.queryDir));
      if (files.length === 0) {
        this.warn(`no 'use server' modules found under ${options.queryDir}`);
      }
      let out = '';
      files.forEach((f, i) => {
        out += `import * as m${i} from ${JSON.stringify(f)};\n`;
      });
      out += `export const queries = {};\n`;
      files.forEach((f, i) => {
        out +=
          `for (const [name, factory] of Object.entries(m${i})) ` +
          `queries[${JSON.stringify(moduleId(f) + '#')} + name] = factory;\n`;
      });
      return out;
    },

    transform(code, id) {
      if (options.side !== 'client' || !isQueryModule(id)) return null;
      const ref = moduleId(id);
      const names = collectExportNames(this.parse(code) as unknown as EsNode, ref);
      let out = '';
      for (const name of names) {
        const stub = `(...args) => ({ $$kesq: ${JSON.stringify(`${ref}#${name}`)}, args })`;
        out += name === 'default' ? `export default ${stub};\n` : `export const ${name} = ${stub};\n`;
      }
      return { code: out, map: { mappings: '' } };
    },
  };
}

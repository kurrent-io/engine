import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'rollup';

/*
 * Bundler integration for KESQ with *runtime* query placement.
 *
 * A module whose source begins with a `'use server'` directive contains
 * *flexible query factories*: functions taking serializable arguments and
 * returning a framework query function.  Flexible queries can execute in the
 * browser or on the query server, chosen per call site at runtime:
 *
 * - In the *server* build the module is included as-is, and the virtual
 *   module `kesq:queries` exports a registry mapping "<module>#<export>" to
 *   the factory, for every directive module found under `queryDir`.  The
 *   query server looks up incoming subscriptions in this registry.
 *
 * - In the *client* build the module is kept — but imports of it are routed
 *   through a generated proxy that wraps every export, so calling
 *   `listStats(id)` returns `{ $$kesq: "src/queries/server.ts#listStats",
 *   args: [id], fn: <query function> }`: the wire reference for subscribing
 *   remotely *and* the locally-instantiated query function, side by side.
 *   useQuery picks one at runtime.  Types still come from the real source,
 *   so call sites look identical to plain local queries.
 *
 * Module ids are package-root-relative paths, which keeps the two sides in
 * agreement without emitting a manifest file.
 */

const REGISTRY = 'kesq:queries';
const RESOLVED_REGISTRY = '\0' + REGISTRY;
const RUNTIME = 'kesq:runtime';
const RESOLVED_RUNTIME = '\0' + RUNTIME;
const FLEX_PREFIX = '\0kesq-flex:';

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

// the id shared by the client's references and the server's registry
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

const RUNTIME_SOURCE = `
/* Wraps a query factory so that calling it yields both halves of a flexible
   query: the wire reference for subscribing to the query server, and the
   locally-instantiated query function.  The consumer picks a side. */
export function wrapFlex(id, factory) {
  return (...args) => ({ $$kesq: id, args, fn: factory(...args) });
}
`;

export default function kesq2(
  options: { side: 'server'; queryDir: string } | { side: 'client' },
): Plugin {
  return {
    name: 'kesq2',

    resolveId: {
      // must run before node-resolve, or the plain resolution wins and the
      // proxy is never created
      order: 'pre',
      async handler(source, importer, resolveOptions) {
        if (options.side === 'server') {
          return source === REGISTRY ? RESOLVED_REGISTRY : null;
        }
        if (source === RUNTIME) return RESOLVED_RUNTIME;
        // the proxy's own import of the real module must resolve normally
        if (source.startsWith('\0') || importer?.startsWith(FLEX_PREFIX)) return null;
        const resolved = await this.resolve(source, importer, {
          ...resolveOptions,
          skipSelf: true,
        });
        if (!resolved || resolved.external || !isQueryModule(resolved.id)) return null;
        return FLEX_PREFIX + resolved.id;
      },
    },

    async load(id) {
      if (options.side === 'server') {
        if (id !== RESOLVED_REGISTRY) return null;
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
      }

      if (id === RESOLVED_RUNTIME) return RUNTIME_SOURCE;

      if (id.startsWith(FLEX_PREFIX)) {
        const realId = id.slice(FLEX_PREFIX.length);
        const info = await this.load({ id: realId });
        if (!info.ast) this.error(`could not parse ${realId}`);
        const names = collectExportNames(info.ast as unknown as EsNode, realId);
        const ref = moduleId(realId);
        let out =
          `import { wrapFlex } from ${JSON.stringify(RUNTIME)};\n` +
          `import * as __mod from ${JSON.stringify(realId)};\n`;
        for (const name of names) {
          const wrapped = `wrapFlex(${JSON.stringify(`${ref}#${name}`)}, __mod[${JSON.stringify(name)}])`;
          out += name === 'default' ? `export default ${wrapped};\n` : `export const ${name} = ${wrapped};\n`;
        }
        return out;
      }

      return null;
    },
  };
}

import type { ErrorObject } from "ajv";

export type ProjectedError = ErrorObject & { schemaOnly?: boolean; syntheticType?: boolean; originInstancePath?: string };
const within = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
const escapePointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Presentation only: use AJV's decisive failures, never revalidate or rank by error count. */
export function projectUnionErrors(rootSchema: unknown, raw: ProjectedError[]): ProjectedError[] {
  // Backstop for hostile schemas; ordinary sibling unions share one indexing pass.
  let remaining = 20_000;
  const spend = () => {
    if (--remaining < 0) throw new Error("Union projection budget exhausted");
  };
  const resolve = (branch: any, path: string) => {
    const prefixes = [path];
    const seen = new Set();
    while (branch && typeof branch.$ref === "string") {
      spend();
      const ref = branch.$ref;
      if (!ref.startsWith("#/") || seen.has(ref) || seen.size >= 8) throw new Error("Unresolved union branch ref");
      seen.add(ref);
      prefixes.push(ref);
      branch = rootSchema;
      for (const token of decodeURIComponent(ref.slice(2)).split("/")) {
        spend();
        const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!branch || !Object.prototype.hasOwnProperty.call(branch, key)) throw new Error("Unresolved union branch ref");
        branch = branch[key];
      }
    }
    return { schema: branch, prefixes };
  };
  const errors = new Set(raw);
  const unions = raw.filter(e => {
    spend();
    return ["anyOf", "oneOf"].includes(e.keyword) && Array.isArray(e.schema);
  });
  if (!unions.length) return [...errors];
  const groups = new Map(unions.map(e => [e.instancePath, new Set<ProjectedError>()]));
  const index = (error: ProjectedError, add: boolean) => {
    let path = error.instancePath;
    while (true) {
      spend();
      const group = groups.get(path);
      if (add) group?.add(error);
      else group?.delete(error);
      if (!path) break;
      path = path.slice(0, path.lastIndexOf("/"));
    }
  };
  for (const error of raw) index(error, true);
  const remove = (error: ProjectedError) => { errors.delete(error); index(error, false); };
  const append = (error: ProjectedError) => { errors.add(error); index(error, true); };
  // Inlined refs may reuse a branch schema deeper in another branch. Only
  // attribute paths whose schema traversal also reaches this instance location.
  const atLocation = (error: ProjectedError, prefix: string, base: string) => {
    const tokens = error.schemaPath.slice(prefix.length + 1).split("/");
    const instance = (error.originInstancePath ?? error.instancePath).slice(base.length).split("/").slice(1);
    let position = 0;
    for (let i = 0; i < tokens.length - 1; i++) {
      spend();
      if (tokens[i] === "properties") {
        if (tokens[++i] !== instance[position++]) return false;
      } else if (tokens[i] === "items") {
        if (!/^\d+$/.test(instance[position++] ?? "")) return false;
      } else if (["anyOf", "oneOf", "allOf"].includes(tokens[i])) i++;
      else return false; // Unfamiliar traversal stays unattributed and visible.
    }
    return position === instance.length;
  };
  unions.sort((a, b) => {
    spend();
    return b.instancePath.split("/").length - a.instancePath.split("/").length || b.schemaPath.length - a.schemaPath.length;
  });
  for (const union of unions) {
    spend();
    const branches = (union.schema as unknown[]).map((s, i) => {
      spend();
      return resolve(s, `${union.schemaPath}/${i}`);
    });
    const owners = new Map<ProjectedError, number[]>();
    const immediateTypes: ProjectedError[][] = branches.map(() => []);
    const prefixOwners = new Map<string, number[]>();
    let shortestPrefix = Infinity;
    for (const [i, branch] of branches.entries()) {
      for (const prefix of branch.prefixes) {
        spend();
        const indices = prefixOwners.get(prefix);
        if (indices) indices.push(i);
        else prefixOwners.set(prefix, [i]);
        shortestPrefix = Math.min(shortestPrefix, prefix.length);
      }
    }
    for (const error of groups.get(union.instancePath)!) {
      spend();
      if (error === union || !within(error.instancePath, union.instancePath)) continue;
      const indices = new Set<number>();
      let path = error.schemaPath;
      while (path.length >= shortestPrefix) {
        spend();
        const matching = prefixOwners.get(path);
        if (matching) {
          const matchesLocation = atLocation(error, path, union.instancePath);
          for (const i of matching) {
            spend();
            if (error.keyword === "type" && error.instancePath === union.instancePath && (error.schemaPath === `${path}/type` || (error.syntheticType && matchesLocation))) {
              immediateTypes[i].push(error);
            }
            if (matchesLocation) indices.add(i);
          }
        }
        const slash = path.lastIndexOf("/");
        if (slash < 0) break;
        path = path.slice(0, slash);
      }
      if (indices.size) owners.set(error, [...indices]);
    }
    const ruledOutTypes = new Set(immediateTypes.flat());
    let candidates = branches.map((_, i) => i).filter(i => immediateTypes[i].length === 0);
    let replacement: ProjectedError | undefined;
    if (!candidates.length) {
      replacement = { ...union, keyword: "type", syntheticType: true, params: { type: [...new Set(immediateTypes.flat().flatMap(e => e.params.type))] } };
    } else if (union.data && typeof union.data === "object" && !Array.isArray(union.data)) {
      const data = union.data as Record<string, unknown>;
      const values = (s: any): unknown[] | undefined => s && (Object.hasOwn(s, "const") ? [s.const] : Array.isArray(s.enum) ? s.enum : undefined);
      for (const key of Object.keys(branches[candidates[0]].schema?.properties ?? {})) {
        spend();
        const lists = candidates.map(i => { spend(); return values(branches[i].schema?.properties?.[key]); });
        if (lists.length < 2 || lists.some(v => !v)) continue;
        const allowed = [...new Set(lists.flatMap(v => v!.map(value => { spend(); return value; })))];
        if (allowed.some(v => v !== null && typeof v === "object") || lists.every(v => v!.length === allowed.length)) continue;
        const present = Object.hasOwn(data, key);
        if (!present && !candidates.every(i => branches[i].schema?.required?.includes(key))) continue;
        const matching = candidates.filter((_, i) => lists[i]!.includes(data[key]));
        if (!present || !matching.length) {
          replacement = present ? {
            ...union, keyword: "enum", instancePath: `${union.instancePath}/${escapePointer(key)}`,
            params: { allowedValues: allowed }, data: data[key], schemaOnly: true,
          } : { ...union, keyword: "required", params: { missingProperty: key } };
        } else candidates = matching;
        break;
      }
    }
    // A shared ref can attribute an error to several branches: keep it if ANY
    // surviving branch owns it. Unattributed errors are never removed.
    const kept = [...owners].filter(([error, indices]) => {
      spend();
      return !replacement && !ruledOutTypes.has(error) && indices.some(i => candidates.includes(i));
    }).map(([e]) => e);
    const keep = new Set(kept);
    remove(union);
    for (const error of owners.keys()) if (!keep.has(error)) remove(error);
    for (const error of ruledOutTypes) if (errors.has(error)) remove(error);
    if (replacement) append({ ...replacement, originInstancePath: union.instancePath });
    else if (!kept.length || candidates.length > 1) {
      const overlap = union.keyword === "oneOf" && Array.isArray(union.params.passingSchemas) && union.params.passingSchemas.length > 1;
      append({ ...union, message: overlap ? "matches more than one alternative; exactly one is allowed" : kept.length ? "listed errors describe alternatives" : "matches none of the alternatives" });
    }
  }
  return [...errors];
}

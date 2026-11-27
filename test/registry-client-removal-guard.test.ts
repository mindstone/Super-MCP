import * as fs from "fs";
import * as path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// FOX-11595: a caller holding a stale client must never remove the replacement another
// caller published under the same key. So a client leaves `this.clients` by key only
// through `removeClientIfCurrent`, which compares identity first; shutdown's bulk
// `clear()` in `beginTerminalCloses` is the one deliberate exception.
// Blind spots: this matches only the literal `this.clients.<method>(` shape, so it misses an
// alias (`const m = this.clients; m.delete(id)`), element access (`this["clients"]`) and
// destructuring, and it does not check `this.clients.set` overwriting a replacement.
const REGISTRY = path.resolve(__dirname, "../src/registry.ts");
const ALLOWED: Record<string, string> = {
  delete: "removeClientIfCurrent",
  clear: "beginTerminalCloses",
};

/** Each `this.clients.<method>(...)` call in the registry, with the class member it sits in. */
function clientMapMutations(): Array<{ method: string; member: string; line: number }> {
  const source = ts.createSourceFile(REGISTRY, fs.readFileSync(REGISTRY, "utf8"), ts.ScriptTarget.Latest, true);
  const found: Array<{ method: string; member: string; line: number }> = [];
  const visit = (node: ts.Node, member: string) => {
    if (
      (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessor(node)) &&
      node.name && ts.isIdentifier(node.name)
    ) {
      member = node.name.text;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.expression.expression.name.text === "clients"
    ) {
      const method = node.expression.name.text;
      if (method in ALLOWED) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        found.push({ method, member, line });
      }
    }
    ts.forEachChild(node, (child) => visit(child, member));
  };
  visit(source, "<module>");
  return found;
}

describe("registry client-map removal", () => {
  it("removes a client by key only through the identity-checking helper", () => {
    const mutations = clientMapMutations();
    // The helper's own delete and shutdown's clear are found, so the scan is not vacuous.
    expect(mutations.map(({ method, member }) => `${method}@${member}`).sort())
      .toEqual(["clear@beginTerminalCloses", "delete@removeClientIfCurrent"]);
    const offenders = mutations.filter(({ method, member }) => ALLOWED[method] !== member);
    expect(offenders).toEqual([]);
  });
});

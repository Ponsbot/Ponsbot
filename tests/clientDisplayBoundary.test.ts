import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { shortAddress } from "../lib/address-display";

const root = process.cwd();
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : /\.tsx?$/.test(filename) ? [filename] : [];
  });
}

// Follow the emitted runtime graph, not erased `import type` declarations.
function runtimeImports(filename: string) {
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext },
  }).outputText;
  const file = ts.createSourceFile(filename, output, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  return file.statements.flatMap(node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      return [node.moduleSpecifier.text];
    return [];
  });
}

describe("client display/server data boundary", () => {
  it("retains address casing and the existing first-six/last-four display", () => {
    expect(shortAddress("0xAbCd12345678901234567890123456789012eF90")).toBe("0xAbCd…eF90");
  });

  it("keeps runtime server-only modules out of every client component", () => {
    const clients = [...sourceFiles(path.join(root, "components")), ...sourceFiles(path.join(root, "app"))]
      .filter(filename => /^\s*["']use client["'];?/.test(readFileSync(filename, "utf8")));
    expect(clients).toContain(path.join(root, "components", "TokenActivity.tsx"));
    const imports = new Map<string, string[]>();
    for (const client of clients) {
      const visited = new Set<string>();
      const walk = (filename: string, chain: string[]) => {
        if (visited.has(filename)) return;
        visited.add(filename);
        if (!imports.has(filename)) imports.set(filename, runtimeImports(filename));
        for (const name of imports.get(filename)!) {
          expect(name, [...chain, path.relative(root, filename), name].join(" -> ")).not.toMatch(/^(server-only|next\/cache|node:)/);
          const base = name.startsWith("@/") ? path.resolve(root, name.slice(2))
            : name.startsWith(".") ? path.resolve(path.dirname(filename), name) : undefined;
          if (!base) continue;
          const dependency = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts"), path.join(base, "index.tsx")]
            .find(candidate => /\.[cm]?[jt]sx?$/.test(candidate) && existsSync(candidate));
          if (dependency) walk(dependency, [...chain, path.relative(root, filename)]);
        }
      };
      walk(client, []);
    }
  });

  it("preserves the guard on cache and data modules", () => {
    for (const filename of ["lib/public-display-cache.ts", "lib/site-data.ts"])
      expect(readFileSync(path.resolve(root, filename), "utf8")).toMatch(/^import "server-only";/);
    expect(runtimeImports(path.resolve(root, "lib/address-display.ts"))).toEqual([]);
  });
});

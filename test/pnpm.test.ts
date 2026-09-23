import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { linkClosure, mergeByPurl } from "../src/lib/pnpm.js";
import type { CycloneDx } from "../src/lib/cyclonedx.js";

// Mirrors helios-core's frontend-workspace: apps link: into packages/, and
// those packages link: into each other.
function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "pnpm-ws-"));
  const write = (dir: string, deps: Record<string, string>) => {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, "package.json"), JSON.stringify({ dependencies: deps }));
  };
  write("console", {
    react: "^19.0.0",
    "@markupai/sidebar": "link:../packages/sidebar",
    "@markupai/api-client": "link:../packages/api-client",
  });
  write("packages/sidebar", {
    "tailwind-merge": "^3.0.0",
    "@markupai/design-system": "link:../design-system",
  });
  write("packages/design-system", { cmdk: "^1.0.0", "@markupai/api-client": "link:../api-client" });
  write("packages/api-client", {});
  write("standalone", { lodash: "^4.0.0" });
  return root;
}

describe("linkClosure", () => {
  let root: string;
  beforeEach(() => {
    root = workspace();
  });

  it("follows link: deps transitively, entry first", async () => {
    expect(await linkClosure(root, "console")).toEqual([
      "console",
      "packages/sidebar",
      "packages/design-system",
      "packages/api-client",
    ]);
  });

  it("visits a shared package once", async () => {
    const closure = await linkClosure(root, "console");
    expect(closure.filter((p) => p === "packages/api-client")).toHaveLength(1);
  });

  it("returns just the package when nothing is linked", async () => {
    expect(await linkClosure(root, "standalone")).toEqual(["standalone"]);
  });

  it("names the package that can't be read", async () => {
    await expect(linkClosure(root, "missing")).rejects.toThrow("missing/package.json");
  });
});

describe("mergeByPurl", () => {
  const bom = (components: { name: string; purl?: string }[], extra = {}): CycloneDx => ({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: { component: { name: "console", type: "application" } },
    components,
    ...extra,
  });

  it("keeps one entry per purl and the entry package's metadata", () => {
    const merged = mergeByPurl([
      bom([{ name: "react", purl: "pkg:npm/react@19.0.0" }]),
      bom(
        [
          { name: "react", purl: "pkg:npm/react@19.0.0" },
          { name: "cmdk", purl: "pkg:npm/cmdk@1.0.0" },
        ],
        { metadata: { component: { name: "design-system", type: "library" } } },
      ),
    ]);
    expect(merged.components?.map((c) => c.name)).toEqual(["react", "cmdk"]);
    expect(merged.metadata?.component?.name).toBe("console");
  });

  it("falls back to name@version when a component has no purl", () => {
    const merged = mergeByPurl([bom([{ name: "vendored" }]), bom([{ name: "vendored" }])]);
    expect(merged.components).toHaveLength(1);
  });

  it("drops the dependency graph, whose bom-refs are per document", () => {
    const merged = mergeByPurl([
      bom([{ name: "react", purl: "pkg:npm/react@19.0.0" }], {
        dependencies: [{ ref: "console", dependsOn: ["pkg:npm/react@19.0.0"] }],
      }),
    ]);
    expect(merged.dependencies).toBeUndefined();
  });

  it("refuses an empty merge", () => {
    expect(() => mergeByPurl([])).toThrow("nothing to merge");
  });
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Component, CycloneDx } from "./cyclonedx.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const LINK = /^(link|workspace):/;

/**
 * `pnpm sbom --filter ./pkg` reports the package's own dependencies but not
 * those of the workspace packages it links to, and the `...` filter suffix
 * doesn't change that. So walk the link graph and generate one BOM per
 * package. Returns workspace-relative directories, the entry package first.
 */
export async function linkClosure(workspace: string, entry: string): Promise<string[]> {
  const seen = new Set<string>();

  const walk = async (dir: string): Promise<void> => {
    const normalised = path.normalize(dir);
    if (seen.has(normalised)) return;
    seen.add(normalised);

    let manifest: PackageJson;
    try {
      manifest = JSON.parse(
        await readFile(path.join(workspace, normalised, "package.json"), "utf8"),
      ) as PackageJson;
    } catch (e) {
      throw new Error(`cannot read ${normalised}/package.json`, { cause: e });
    }

    for (const spec of Object.values(manifest.dependencies ?? {})) {
      if (!LINK.test(spec)) continue;
      const target = spec.replace(LINK, "");
      // workspace:* points at a package by name, not a path; pnpm resolves
      // those itself, so only link: targets need walking.
      if (!target.startsWith(".")) continue;
      await walk(path.join(normalised, target));
    }
  };

  await walk(entry);
  return [...seen];
}

/**
 * Merges per-package BOMs into one, keeping the entry package's metadata.
 * The lockfile resolves each package once, so the same purl from two
 * workspace packages is the same component.
 */
export function mergeByPurl(boms: CycloneDx[]): CycloneDx {
  if (boms.length === 0) throw new Error("nothing to merge");
  const seen = new Set<string>();
  const components: Component[] = [];

  for (const bom of boms) {
    for (const component of bom.components ?? []) {
      const key = component.purl ?? `${component.name ?? ""}@${component.version ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      components.push(component);
    }
  }

  // dependency graphs reference bom-refs from their own document, so they
  // can't be concatenated meaningfully; drop rather than publish a broken one.
  const merged: CycloneDx = { ...boms[0], components };
  delete merged.dependencies;
  return merged;
}

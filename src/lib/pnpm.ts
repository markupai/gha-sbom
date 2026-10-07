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
 * package. `packages` maps each workspace package's name to its
 * workspace-relative directory, for `workspace:` deps that name a package
 * rather than a path. Returns workspace-relative directories, the entry
 * package first.
 */
export async function linkClosure(
  workspace: string,
  entry: string,
  packages: ReadonlyMap<string, string>,
): Promise<string[]> {
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

    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!LINK.test(spec)) continue;
      const target = spec.replace(LINK, "");
      if (target.startsWith(".")) {
        await walk(path.join(normalised, target));
        continue;
      }
      if (!spec.startsWith("workspace:")) continue;
      // Skipping an unresolved name would silently drop that package's
      // dependencies from the BOM.
      const dir = packages.get(name);
      if (dir === undefined) {
        throw new Error(
          `${normalised} depends on ${name} (${spec}), which is not a workspace package`,
        );
      }
      await walk(dir);
    }
  };

  await walk(entry);
  return [...seen];
}

/**
 * Maps each package in `pnpm -r ls --depth -1 --json` output to its directory
 * relative to `root`, the workspace root as pnpm resolved it.
 */
export function workspacePackages(json: string, root: string): Map<string, string> {
  const projects = JSON.parse(json) as { name?: string; path: string }[];
  const packages = new Map<string, string>();
  for (const project of projects) {
    if (project.name === undefined) continue;
    packages.set(project.name, path.relative(root, project.path));
  }
  return packages;
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

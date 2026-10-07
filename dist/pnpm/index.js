import { g as getInput, i as info, s as setOutput, a as setFailed, e as exec, p as parseCycloneDx } from '../cyclonedx-DmbMCbx0.js';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import 'os';
import 'crypto';
import 'fs';
import 'path';
import 'http';
import 'https';
import 'net';
import 'tls';
import 'events';
import 'assert';
import 'util';
import 'node:assert';
import 'node:net';
import 'node:http';
import 'node:stream';
import 'node:buffer';
import 'node:util';
import 'node:querystring';
import 'node:events';
import 'node:diagnostics_channel';
import 'node:tls';
import 'node:zlib';
import 'node:perf_hooks';
import 'node:util/types';
import 'node:worker_threads';
import 'node:url';
import 'node:async_hooks';
import 'node:console';
import 'node:dns';
import 'string_decoder';
import 'child_process';
import 'timers';
import 'node:crypto';

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
async function linkClosure(workspace, entry, packages) {
    const seen = new Set();
    const walk = async (dir) => {
        const normalised = path.normalize(dir);
        if (seen.has(normalised))
            return;
        seen.add(normalised);
        let manifest;
        try {
            manifest = JSON.parse(await readFile(path.join(workspace, normalised, "package.json"), "utf8"));
        }
        catch (e) {
            throw new Error(`cannot read ${normalised}/package.json`, { cause: e });
        }
        for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
            if (!LINK.test(spec))
                continue;
            const target = spec.replace(LINK, "");
            if (target.startsWith(".")) {
                await walk(path.join(normalised, target));
                continue;
            }
            if (!spec.startsWith("workspace:"))
                continue;
            // Skipping an unresolved name would silently drop that package's
            // dependencies from the BOM.
            const dir = packages.get(name);
            if (dir === undefined) {
                throw new Error(`${normalised} depends on ${name} (${spec}), which is not a workspace package`);
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
function workspacePackages(json, root) {
    const projects = JSON.parse(json);
    const packages = new Map();
    for (const project of projects) {
        if (project.name === undefined)
            continue;
        packages.set(project.name, path.relative(root, project.path));
    }
    return packages;
}
/**
 * Merges per-package BOMs into one, keeping the entry package's metadata.
 * The lockfile resolves each package once, so the same purl from two
 * workspace packages is the same component.
 */
function mergeByPurl(boms) {
    if (boms.length === 0)
        throw new Error("nothing to merge");
    const seen = new Set();
    const components = [];
    for (const bom of boms) {
        for (const component of bom.components ?? []) {
            const key = component.purl ?? `${component.name ?? ""}@${component.version ?? ""}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            components.push(component);
        }
    }
    // dependency graphs reference bom-refs from their own document, so they
    // can't be concatenated meaningfully; drop rather than publish a broken one.
    const merged = { ...boms[0], components };
    delete merged.dependencies;
    return merged;
}

async function sbomFor(workspace, pkg, specVersion) {
    let stdout = "";
    await exec("pnpm", [
        "sbom",
        "--sbom-format",
        "cyclonedx",
        "--sbom-spec-version",
        specVersion,
        "--lockfile-only",
        "--prod",
        "--filter",
        `./${pkg}`,
    ], {
        cwd: workspace,
        silent: true,
        listeners: { stdout: (data) => (stdout += data.toString()) },
    });
    return parseCycloneDx(stdout, `pnpm sbom ./${pkg}`);
}
async function listWorkspace(workspace) {
    let stdout = "";
    await exec("pnpm", ["-r", "ls", "--depth", "-1", "--json"], {
        cwd: workspace,
        silent: true,
        listeners: { stdout: (data) => (stdout += data.toString()) },
    });
    // pnpm reports real paths, so a symlinked workspace (macOS /tmp) needs resolving too.
    return workspacePackages(stdout, await realpath(workspace));
}
async function run() {
    try {
        const workspace = getInput("workspace", { required: true });
        const pkg = getInput("package", { required: true });
        const specVersion = getInput("spec-version", { required: true });
        const packages = await linkClosure(workspace, pkg, await listWorkspace(workspace));
        info(`${pkg}: ${String(packages.length)} workspace package(s): ${packages.join(", ")}`);
        const boms = [];
        for (const each of packages)
            boms.push(await sbomFor(workspace, each, specVersion));
        const merged = mergeByPurl(boms);
        const output = getInput("output") ||
            path.join(process.env.RUNNER_TEMP ?? ".", "gha-sbom", `${path.basename(pkg)}.cdx.json`);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify(merged, null, 2));
        const own = boms[0].components?.length ?? 0;
        const total = merged.components?.length ?? 0;
        info(`${pkg}: ${String(total)} components (${String(own)} without the link closure)`);
        setOutput("sbom", output);
        setOutput("components", total);
    }
    catch (e) {
        setFailed(e instanceof Error ? e.message : String(e));
    }
}

await run();
//# sourceMappingURL=index.js.map

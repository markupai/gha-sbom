import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseCycloneDx, type CycloneDx } from "../lib/cyclonedx.js";
import { linkClosure, mergeByPurl } from "../lib/pnpm.js";

async function sbomFor(workspace: string, pkg: string, specVersion: string): Promise<CycloneDx> {
  let stdout = "";
  await exec.exec(
    "pnpm",
    [
      "sbom",
      "--sbom-format",
      "cyclonedx",
      "--sbom-spec-version",
      specVersion,
      "--lockfile-only",
      "--prod",
      "--filter",
      `./${pkg}`,
    ],
    {
      cwd: workspace,
      silent: true,
      listeners: { stdout: (data: Buffer) => (stdout += data.toString()) },
    },
  );
  return parseCycloneDx(stdout, `pnpm sbom ./${pkg}`);
}

export async function run(): Promise<void> {
  try {
    const workspace = core.getInput("workspace", { required: true });
    const pkg = core.getInput("package", { required: true });
    const specVersion = core.getInput("spec-version", { required: true });

    const packages = await linkClosure(workspace, pkg);
    core.info(`${pkg}: ${String(packages.length)} workspace package(s): ${packages.join(", ")}`);

    const boms: CycloneDx[] = [];
    for (const each of packages) boms.push(await sbomFor(workspace, each, specVersion));
    const merged = mergeByPurl(boms);

    const output =
      core.getInput("output") ||
      path.join(process.env.RUNNER_TEMP ?? ".", "gha-sbom", `${path.basename(pkg)}.cdx.json`);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(merged, null, 2));

    const own = boms[0].components?.length ?? 0;
    const total = merged.components?.length ?? 0;
    core.info(`${pkg}: ${String(total)} components (${String(own)} without the link closure)`);
    core.setOutput("sbom", output);
    core.setOutput("components", total);
  } catch (e) {
    core.setFailed(e instanceof Error ? e.message : String(e));
  }
}

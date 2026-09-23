import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Kind,
  parseCycloneDx,
  s3Key,
  stamp,
  stats,
  validateMeta,
  type StampMeta,
} from "../lib/cyclonedx.js";
import { sha256File } from "../lib/digest.js";
import { finaliseSpdx, type SpdxDoc } from "../lib/spdx.js";
import { installSyft } from "../lib/syft.js";

function intInput(name: string): number {
  const raw = core.getInput(name);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

async function resolveDigest(kind: Kind): Promise<Pick<StampMeta, "digest" | "subject">> {
  const digest = core.getInput("digest");
  const subjectPath = core.getInput("subject-path");
  if (digest && subjectPath) throw new Error("set digest or subject-path, not both");
  if (digest) return { digest, subject: "image" };
  if (subjectPath) {
    if (!existsSync(subjectPath)) throw new Error(`subject-path not found: ${subjectPath}`);
    return { digest: await sha256File(subjectPath), subject: "artefact" };
  }
  if (kind === "release") return {};
  throw new Error("set digest (images) or subject-path (artefacts)");
}

export async function run(): Promise<void> {
  try {
    const sbomPath = core.getInput("sbom", { required: true });
    const kind = core.getInput("kind", { required: true });
    if (kind !== "source" && kind !== "image" && kind !== "release") {
      throw new Error("kind must be source, image or release");
    }
    const env = process.env;

    const meta: StampMeta = {
      product: core.getInput("product", { required: true }),
      component: core.getInput("component", { required: true }),
      version: core.getInput("version", { required: true }),
      commit: core.getInput("commit", { required: true }),
      kind,
      backfill: core.getBooleanInput("backfill"),
      rootName: core.getInput("root-name") || undefined,
      runUrl: `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY ?? ""}/actions/runs/${env.GITHUB_RUN_ID ?? ""}`,
      ...(await resolveDigest(kind)),
    };
    validateMeta(meta);

    const bom = parseCycloneDx(await readFile(sbomPath, "utf8"), sbomPath);
    const s = stats(bom);
    const minComponents = intInput("min-components");
    if (s.components < minComponents) {
      throw new Error(
        `${sbomPath} has ${String(s.components)} components, expected at least ${String(minComponents)}. A generator probably failed to resolve dependencies.`,
      );
    }
    const minLicencePct = intInput("min-licence-pct");
    if (s.licencePct < minLicencePct) {
      core.warning(
        `${meta.component} ${kind} SBOM has licence data on ${String(s.licensed)}/${String(s.components)} components (${String(s.licencePct)}%), below ${String(minLicencePct)}%`,
      );
    }

    const outDir =
      core.getInput("output-dir") ||
      path.join(
        env.RUNNER_TEMP ?? ".",
        "gha-sbom",
        meta.component,
        (meta.digest ?? meta.version).slice(0, 24).replace(/[^A-Za-z0-9._-]/g, "-"),
      );
    await mkdir(outDir, { recursive: true });
    const cdxPath = path.join(outDir, `${kind}.cdx.json`);
    await writeFile(cdxPath, JSON.stringify(stamp(bom, meta, new Date()), null, 2));

    let spdxPath = "";
    if (core.getBooleanInput("spdx")) {
      const syft = await installSyft(core.getInput("syft-version", { required: true }));
      const raw = path.join(outDir, `${kind}.spdx.raw.json`);
      await exec.exec(syft, ["convert", cdxPath, "-o", `spdx-json@2.3=${raw}`], {
        env: { ...env, SYFT_CHECK_FOR_APP_UPDATE: "false" },
      });
      const doc = JSON.parse(await readFile(raw, "utf8")) as SpdxDoc;
      spdxPath = path.join(outDir, `${kind}.spdx.json`);
      await writeFile(spdxPath, JSON.stringify(finaliseSpdx(doc, meta), null, 2));
      await rm(raw);
    }

    core.info(
      `${meta.component} ${kind} SBOM: ${String(s.components)} components, licence data on ${String(s.licencePct)}%${meta.digest ? `, ${meta.digest}` : ""}`,
    );
    core.setOutput("cdx", cdxPath);
    core.setOutput("spdx", spdxPath);
    core.setOutput("digest", meta.digest ?? "");
    core.setOutput("key", s3Key(meta));
    core.setOutput("components", s.components);
    core.setOutput("licence-pct", s.licencePct);
  } catch (e) {
    core.setFailed(e instanceof Error ? e.message : String(e));
  }
}

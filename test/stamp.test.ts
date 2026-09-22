import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/stamp/main.js";

// Drives the action the way the runner does: inputs as INPUT_* env vars,
// outputs read back from the GITHUB_OUTPUT file.
function setInputs(inputs: Record<string, string>) {
  const defaults: Record<string, string> = {
    commit: "bc61658b31",
    "min-components": "1",
    "min-licence-pct": "0",
    spdx: "false",
    backfill: "false",
    "syft-version": "v1.52.0",
  };
  for (const [k, v] of Object.entries({ ...defaults, ...inputs })) {
    process.env[`INPUT_${k.replace(/ /g, "_").toUpperCase()}`] = v;
  }
}

function outputs(file: string): Record<string, string> {
  // @actions/core writes name<<delim\nvalue\ndelim blocks
  const out: Record<string, string> = {};
  const re = /^(.+?)<<(.+)\n([\s\S]*?)\n\2$/gm;
  for (const m of readFileSync(file, "utf8").matchAll(re)) out[m[1]] = m[3];
  return out;
}

describe("stamp action", () => {
  let dir: string;
  let outFile: string;

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("INPUT_")) Reflect.deleteProperty(process.env, k);
    }
    dir = mkdtempSync(path.join(tmpdir(), "gha-sbom-"));
    outFile = path.join(dir, "output");
    writeFileSync(outFile, "");
    process.env.GITHUB_OUTPUT = outFile;
    process.env.RUNNER_TEMP = dir;
    process.exitCode = undefined;
  });

  it("stamps an artefact SBOM with the file's sha256", async () => {
    setInputs({
      sbom: "test/fixtures/npm.cdx.json",
      kind: "source",
      product: "integrations",
      component: "figma-plugin",
      version: "v1.3.2",
      "subject-path": "test/fixtures/artefact.bin",
    });
    await run();
    expect(process.exitCode).toBeUndefined();

    const o = outputs(outFile);
    const expected = createHash("sha256")
      .update(readFileSync("test/fixtures/artefact.bin"))
      .digest("hex");
    expect(o.digest).toBe(`sha256:${expected}`);
    expect(o.key).toBe(`integrations/figma-plugin/v1.3.2/sha256-${o.digest.slice(7)}`);
    expect(o.components).toBe("4");
    expect(o.spdx).toBe("");

    const bom = JSON.parse(readFileSync(o.cdx, "utf8")) as {
      metadata: { properties: { name: string; value: string }[] };
    };
    expect(bom.metadata.properties).toContainEqual({ name: "markupai:sha256", value: o.digest });
  });

  it("fails on an empty SBOM instead of publishing it", async () => {
    setInputs({
      sbom: "test/fixtures/empty.cdx.json",
      kind: "source",
      product: "sls",
      component: "nlp",
      version: "v0.29.0",
      digest: `sha256:${"c".repeat(64)}`,
    });
    await run();
    expect(process.exitCode).toBe(1);
  });

  it("refuses both digest and subject-path", async () => {
    setInputs({
      sbom: "test/fixtures/npm.cdx.json",
      kind: "source",
      product: "sls",
      component: "nlp",
      version: "v0.29.0",
      digest: `sha256:${"c".repeat(64)}`,
      "subject-path": "test/fixtures/artefact.bin",
    });
    await run();
    expect(process.exitCode).toBe(1);
  });
});

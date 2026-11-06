import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Execute the actual github-script body rather than a copy of the lookup logic.
const action = readFileSync(new URL("../image/action.yml", import.meta.url), "utf8");
const script = action.match(/ {8}script: \|\n([\s\S]*?)\n {4}- name:/)?.[1];
if (!script) throw new Error("image action lookup script not found");
const lookup = script.replace(/^ {10}/gm, "");
const digest = `sha256:${"a".repeat(64)}`;
const repo = { owner: "markupai", repo: "gha-sbom" };
const predicateType = "https://cyclonedx.org/bom";

type Attestation = { predicateType: string; bundle_url: string };

async function plan({
  attestations = [],
  error,
  skipIfAttested = "true",
  subjectDigest = digest,
}: {
  attestations?: Attestation[];
  error?: { status: number };
  skipIfAttested?: string;
  subjectDigest?: string;
} = {}) {
  const outputs: Record<string, string> = {};
  const core = {
    setOutput: vi.fn((name: string, value: string) => {
      outputs[name] = value;
    }),
    setFailed: vi.fn(),
    notice: vi.fn(),
  };
  const request = vi.fn((route: string, params: Record<string, unknown>) => {
    expect(route).toBe("GET /repos/{owner}/{repo}/attestations/{subject_digest}");
    expect(params).toEqual({
      ...repo,
      subject_digest: digest,
      predicate_type: predicateType,
      headers: { "X-GitHub-Api-Version": "2026-03-10" },
    });
    if (error) throw Object.assign(new Error("Attestation lookup failed"), error);
    // Model the documented server-side filter and the new bundle_url-only shape.
    return {
      data: {
        attestations: attestations
          .filter((a) => a.predicateType === params.predicate_type)
          .map((a) => ({ bundle_url: a.bundle_url })),
      },
    };
  });
  const execution = runInNewContext(`(async () => {\n${lookup}\n})()`, {
    core,
    github: { request },
    context: { repo },
    process: {
      env: {
        DIGEST: subjectDigest,
        SKIP_IF_ATTESTED: skipIfAttested,
        RUNNER_TEMP: "/runner-temp",
      },
    },
  }) as Promise<void>;
  await execution;
  return { outputs, core, request };
}

describe("image attestation lookup", () => {
  it("skips a CycloneDX attestation without an inline bundle", async () => {
    const { outputs, core, request } = await plan({
      attestations: [{ predicateType, bundle_url: "https://example.com/bundle" }],
    });
    expect(request).toHaveBeenCalledOnce();
    expect(outputs.skip).toBe("true");
    expect(core.notice).toHaveBeenCalledOnce();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("scans when no attestation exists", async () => {
    const { outputs, request } = await plan();
    expect(request).toHaveBeenCalledOnce();
    expect(outputs).toEqual({
      path: `/runner-temp/gha-sbom-image-${digest.slice(7, 19)}.cdx.json`,
      skip: "false",
    });
  });

  it("scans when only a non-CycloneDX attestation exists", async () => {
    const { outputs, request } = await plan({
      attestations: [
        {
          predicateType: "https://slsa.dev/provenance/v1",
          bundle_url: "https://example.com/bundle",
        },
      ],
    });
    expect(request).toHaveBeenCalledOnce();
    expect(outputs.skip).toBe("false");
  });

  it("scans when the lookup returns 404", async () => {
    const { outputs } = await plan({ error: { status: 404 } });
    expect(outputs.skip).toBe("false");
  });

  it.each([403, 500])("propagates lookup failures with status %i", async (status) => {
    await expect(plan({ error: { status } })).rejects.toMatchObject({ status });
  });

  it("does not query attestations when skipping is disabled", async () => {
    const { outputs, request } = await plan({ skipIfAttested: "false" });
    expect(request).not.toHaveBeenCalled();
    expect(outputs.skip).toBe("false");
  });

  it("rejects an invalid digest before making a request", async () => {
    const { outputs, core, request } = await plan({ subjectDigest: "invalid" });
    expect(request).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith("digest 'invalid' is not sha256:<64 hex>");
    expect(outputs).toEqual({});
  });
});

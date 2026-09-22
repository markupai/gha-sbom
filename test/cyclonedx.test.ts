import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseCycloneDx,
  s3Key,
  stamp,
  stats,
  validateMeta,
  type StampMeta,
} from "../src/lib/cyclonedx.js";

const fixture = (name: string) =>
  parseCycloneDx(readFileSync(`test/fixtures/${name}`, "utf8"), name);

const meta: StampMeta = {
  product: "sls",
  component: "language-server",
  version: "v0.29.0",
  commit: "bc61658b31",
  digest: `sha256:${"a".repeat(64)}`,
  subject: "image",
  kind: "source",
  backfill: false,
  runUrl: "https://github.com/markupai/scalable-language-servers/actions/runs/1",
};

describe("validateMeta", () => {
  it("accepts a normal release", () => {
    expect(() => {
      validateMeta(meta);
    }).not.toThrow();
  });

  it.each([
    ["product", "../etc"],
    ["component", "helios one"],
    ["version", "helios-one/v2026.09.18.02"],
  ] as const)("rejects %s values that would break the S3 key", (field, value) => {
    expect(() => {
      validateMeta({ ...meta, [field]: value });
    }).toThrow(field);
  });

  it("rejects a tag where a digest belongs", () => {
    expect(() => {
      validateMeta({ ...meta, digest: "b4be53d" });
    }).toThrow("sha256");
  });

  it("rejects a non-SHA commit", () => {
    expect(() => {
      validateMeta({ ...meta, commit: "main" });
    }).toThrow("commit");
  });
});

describe("parseCycloneDx", () => {
  it("rejects SPDX passed by mistake", () => {
    expect(() => parseCycloneDx('{"spdxVersion":"SPDX-2.3"}', "x.json")).toThrow("not a CycloneDX");
  });
});

describe("stats", () => {
  it("ignores syft file entries and counts licences", () => {
    expect(stats(fixture("maven.cdx.json"))).toEqual({
      components: 3,
      licensed: 2,
      licencePct: 66,
    });
  });

  it("reports an empty BOM as zero", () => {
    expect(stats(fixture("empty.cdx.json")).components).toBe(0);
  });
});

describe("stamp", () => {
  const now = new Date("2026-09-22T10:00:00Z");

  it("replaces earlier markupai properties and keeps generator ones", () => {
    const props = stamp(fixture("maven.cdx.json"), meta, now).metadata?.properties ?? [];
    expect(props.filter((p) => p.name === "markupai:version")).toEqual([
      { name: "markupai:version", value: "v0.29.0" },
    ]);
    expect(props).toContainEqual({ name: "cdx:maven:package:test", value: "keep" });
    expect(props).toContainEqual({ name: "markupai:image-digest", value: meta.digest });
    expect(props).toContainEqual({ name: "markupai:s3-key", value: s3Key(meta) });
  });

  it("records artefacts under markupai:sha256", () => {
    const props = stamp(fixture("npm.cdx.json"), { ...meta, subject: "artefact" }, now).metadata
      ?.properties;
    expect(props).toContainEqual({ name: "markupai:sha256", value: meta.digest });
  });

  it("renames the root component when asked and drops its stale purl", () => {
    const out = stamp(fixture("npm.cdx.json"), { ...meta, rootName: "console" }, now);
    expect(out.metadata?.component?.name).toBe("console");
    expect(out.metadata?.component?.version).toBe("v0.29.0");
    expect(out.metadata?.component?.purl).toBeUndefined();
  });

  it("adds a serialNumber when the generator left it out", () => {
    const input = fixture("npm.cdx.json");
    expect(input.serialNumber).toBeUndefined();
    expect(stamp(input, meta, now).serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });

  it("keeps the generator's serialNumber", () => {
    const input = { ...fixture("npm.cdx.json"), serialNumber: "urn:uuid:keep" };
    expect(stamp(input, meta, now).serialNumber).toBe("urn:uuid:keep");
  });

  it("leaves components untouched", () => {
    const input = fixture("npm.cdx.json");
    expect(stamp(input, meta, now).components).toEqual(input.components);
  });
});

describe("s3Key", () => {
  it("uses a colon-free digest segment", () => {
    expect(s3Key(meta)).toBe(`sls/language-server/v0.29.0/sha256-${"a".repeat(64)}`);
  });
});

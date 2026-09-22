import { randomUUID } from "node:crypto";

export type Kind = "source" | "image";

export interface Property {
  name: string;
  value: string;
}

export interface Component {
  type?: string;
  name?: string;
  version?: string;
  purl?: string;
  "bom-ref"?: string;
  licenses?: unknown[];
  [key: string]: unknown;
}

export interface CycloneDx {
  bomFormat: string;
  specVersion?: string;
  serialNumber?: string;
  metadata?: {
    timestamp?: string;
    component?: Component;
    properties?: Property[];
    [key: string]: unknown;
  };
  components?: Component[];
  [key: string]: unknown;
}

export interface StampMeta {
  product: string;
  component: string;
  version: string;
  commit: string;
  /** sha256:<hex> of the image manifest or the artefact file */
  digest: string;
  /** image digest vs artefact file hash; they are recorded under different property names */
  subject: "image" | "artefact";
  kind: Kind;
  backfill: boolean;
  runUrl: string;
  /** Overrides metadata.component (e.g. pnpm names the root after the workspace, not the package) */
  rootName?: string;
}

const SAFE = /^[A-Za-z0-9._+-]+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const PREFIX = "markupai:";

export function validateMeta(meta: StampMeta): void {
  for (const field of ["product", "component", "version"] as const) {
    if (!SAFE.test(meta[field])) {
      throw new Error(
        `${field} '${meta[field]}' must match ${SAFE.source}; it becomes part of the S3 key`,
      );
    }
  }
  if (!COMMIT.test(meta.commit)) throw new Error(`commit '${meta.commit}' is not a git SHA`);
  if (!DIGEST.test(meta.digest)) throw new Error(`digest '${meta.digest}' is not sha256:<64 hex>`);
}

export function parseCycloneDx(text: string, source: string): CycloneDx {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source} is not valid JSON`, { cause: e });
  }
  if (typeof doc !== "object" || doc === null || (doc as CycloneDx).bomFormat !== "CycloneDX") {
    throw new Error(`${source} is not a CycloneDX JSON document`);
  }
  return doc as CycloneDx;
}

export function s3Key(meta: Pick<StampMeta, "product" | "component" | "version" | "digest">) {
  return `${meta.product}/${meta.component}/${meta.version}/sha256-${meta.digest.slice(7)}`;
}

export interface Stats {
  components: number;
  licensed: number;
  licencePct: number;
}

/** Counts packages, not the per-file entries syft can emit. */
export function stats(bom: CycloneDx): Stats {
  const packages = (bom.components ?? []).filter((c) => c.type !== "file");
  const licensed = packages.filter((c) => Array.isArray(c.licenses) && c.licenses.length > 0);
  const components = packages.length;
  return {
    components,
    licensed: licensed.length,
    licencePct: components === 0 ? 0 : Math.floor((licensed.length * 100) / components),
  };
}

export function traceProperties(meta: StampMeta): Property[] {
  return [
    { name: "markupai:product", value: meta.product },
    { name: "markupai:component", value: meta.component },
    { name: "markupai:version", value: meta.version },
    { name: "markupai:commit", value: meta.commit },
    {
      name: meta.subject === "image" ? "markupai:image-digest" : "markupai:sha256",
      value: meta.digest,
    },
    { name: "markupai:sbom-kind", value: meta.kind },
    { name: "markupai:s3-key", value: s3Key(meta) },
    { name: "markupai:ci-run", value: meta.runUrl },
    { name: "markupai:backfill", value: String(meta.backfill) },
  ];
}

/** Returns a copy of the BOM with traceability properties replacing any earlier markupai:* ones. */
export function stamp(bom: CycloneDx, meta: StampMeta, now: Date): CycloneDx {
  const metadata = { ...(bom.metadata ?? {}) };
  metadata.timestamp ??= now.toISOString();

  if (meta.rootName) {
    const component: Component = { ...(metadata.component ?? { type: "application" }) };
    delete component.purl;
    delete component["bom-ref"];
    metadata.component = { ...component, name: meta.rootName, version: meta.version };
  }

  metadata.properties = [
    ...(metadata.properties ?? []).filter((p) => !p.name.startsWith(PREFIX)),
    ...traceProperties(meta),
  ];

  // actions/attest only accepts CycloneDX with a serialNumber; every generator
  // we use sets one, but don't let one that doesn't break attestation.
  return { ...bom, serialNumber: bom.serialNumber ?? `urn:uuid:${randomUUID()}`, metadata };
}

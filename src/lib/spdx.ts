import { traceProperties, type StampMeta } from "./cyclonedx.js";

interface SpdxPackage {
  licenseDeclared?: string;
  licenseConcluded?: string;
  [key: string]: unknown;
}

export interface SpdxDoc {
  spdxVersion: string;
  creationInfo?: { comment?: string; [key: string]: unknown };
  packages?: SpdxPackage[];
  [key: string]: unknown;
}

// Deprecated SPDX ids that some registries still publish (mostly Maven), and
// that strict SPDX validators reject. Longest ids first so the exception
// variants are rewritten before their GPL-2.0 prefix.
const DEPRECATED: [string, string][] = [
  ["GPL-2.0-with-classpath-exception", "GPL-2.0-only WITH Classpath-exception-2.0"],
  ["GPL-2.0-with-autoconf-exception", "GPL-2.0-only WITH Autoconf-exception-2.0"],
  ["GPL-2.0-with-bison-exception", "GPL-2.0-or-later WITH Bison-exception-2.2"],
  ["GPL-2.0-with-font-exception", "GPL-2.0-only WITH Font-exception-2.0"],
  ["GPL-2.0-with-GCC-exception", "GPL-2.0-or-later WITH GCC-exception-2.0"],
  ["GPL-3.0-with-autoconf-exception", "GPL-3.0-only WITH Autoconf-exception-3.0"],
  ["GPL-3.0-with-GCC-exception", "GPL-3.0-only WITH GCC-exception-3.1"],
  ["LGPL-2.0+", "LGPL-2.0-or-later"],
  ["LGPL-2.1+", "LGPL-2.1-or-later"],
  ["LGPL-3.0+", "LGPL-3.0-or-later"],
  ["GPL-1.0+", "GPL-1.0-or-later"],
  ["GPL-2.0+", "GPL-2.0-or-later"],
  ["GPL-3.0+", "GPL-3.0-or-later"],
  ["AGPL-1.0", "AGPL-1.0-only"],
  ["AGPL-3.0", "AGPL-3.0-only"],
  ["LGPL-2.0", "LGPL-2.0-only"],
  ["LGPL-2.1", "LGPL-2.1-only"],
  ["LGPL-3.0", "LGPL-3.0-only"],
  ["GPL-1.0", "GPL-1.0-only"],
  ["GPL-2.0", "GPL-2.0-only"],
  ["GPL-3.0", "GPL-3.0-only"],
];

const escape = (s: string) => s.replace(/[.+]/g, "\\$&");
const RULES = DEPRECATED.map(
  ([from, to]) =>
    // Not preceded or followed by an id character, so LGPL-2.1 never matches
    // inside GPL rules and GPL-2.0-only is left alone.
    [new RegExp(`(?<![A-Za-z0-9.+-])${escape(from)}(?![A-Za-z0-9.+-])`, "g"), to] as const,
);

export function normaliseExpression(expr: string): string {
  return RULES.reduce((acc, [re, to]) => acc.replace(re, to), expr);
}

/**
 * Normalises deprecated licence ids and records the traceability stamp in
 * creationInfo.comment, since SPDX has no equivalent of CycloneDX properties
 * and the conversion drops them.
 */
export function finaliseSpdx(doc: SpdxDoc, meta: StampMeta): SpdxDoc {
  const packages = (doc.packages ?? []).map((p) => ({
    ...p,
    ...(p.licenseDeclared ? { licenseDeclared: normaliseExpression(p.licenseDeclared) } : {}),
    ...(p.licenseConcluded ? { licenseConcluded: normaliseExpression(p.licenseConcluded) } : {}),
  }));
  const comment = traceProperties(meta)
    .map((p) => `${p.name}=${p.value}`)
    .join(" ");
  return { ...doc, packages, creationInfo: { ...(doc.creationInfo ?? {}), comment } };
}

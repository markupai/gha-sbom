import { describe, expect, it } from "vitest";
import { finaliseSpdx, normaliseExpression } from "../src/lib/spdx.js";
import type { StampMeta } from "../src/lib/cyclonedx.js";

describe("normaliseExpression", () => {
  it.each([
    ["GPL-2.0-with-classpath-exception", "GPL-2.0-only WITH Classpath-exception-2.0"],
    [
      "(CDDL-1.0 OR GPL-2.0-with-classpath-exception)",
      "(CDDL-1.0 OR GPL-2.0-only WITH Classpath-exception-2.0)",
    ],
    ["GPL-2.0+", "GPL-2.0-or-later"],
    ["LGPL-2.1 AND GPL-2.0", "LGPL-2.1-only AND GPL-2.0-only"],
    ["LGPL-2.1+", "LGPL-2.1-or-later"],
    ["AGPL-3.0", "AGPL-3.0-only"],
  ])("rewrites %s", (from, to) => {
    expect(normaliseExpression(from)).toBe(to);
  });

  it.each([
    "GPL-2.0-only",
    "GPL-3.0-or-later",
    "LGPL-2.1-only",
    "Apache-2.0",
    "MIT OR GPL-3.0-only",
  ])("leaves current id %s alone", (expr) => {
    expect(normaliseExpression(expr)).toBe(expr);
  });
});

describe("finaliseSpdx", () => {
  const meta: StampMeta = {
    product: "sls",
    component: "nlp",
    version: "v0.29.0",
    commit: "bc61658b31",
    digest: `sha256:${"b".repeat(64)}`,
    subject: "image",
    kind: "image",
    backfill: true,
    runUrl: "https://github.com/markupai/scalable-language-servers/actions/runs/1",
  };

  it("normalises package licences and records the stamp in the creation comment", () => {
    const out = finaliseSpdx(
      {
        spdxVersion: "SPDX-2.3",
        creationInfo: { created: "2026-09-22T10:00:00Z" },
        packages: [
          { licenseDeclared: "GPL-2.0-with-classpath-exception", licenseConcluded: "NOASSERTION" },
        ],
      },
      meta,
    );
    expect(out.packages?.[0]).toEqual({
      licenseDeclared: "GPL-2.0-only WITH Classpath-exception-2.0",
      licenseConcluded: "NOASSERTION",
    });
    expect(out.creationInfo?.created).toBe("2026-09-22T10:00:00Z");
    expect(out.creationInfo?.comment).toContain("markupai:image-digest=sha256:bbbb");
    expect(out.creationInfo?.comment).toContain("markupai:backfill=true");
  });
});

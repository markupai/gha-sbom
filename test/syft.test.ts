import { describe, expect, it } from "vitest";
import { assetName } from "../src/lib/syft.js";

describe("assetName", () => {
  it.each([
    ["linux", "x64", "syft_1.52.0_linux_amd64.tar.gz"],
    ["linux", "arm64", "syft_1.52.0_linux_arm64.tar.gz"],
    ["darwin", "arm64", "syft_1.52.0_darwin_arm64.tar.gz"],
    ["win32", "x64", "syft_1.52.0_windows_amd64.zip"],
  ])("%s/%s", (platform, arch, expected) => {
    expect(assetName("v1.52.0", platform, arch)).toBe(expected);
  });

  it("rejects unsupported platforms", () => {
    expect(() => assetName("v1.52.0", "aix", "ppc64")).toThrow("no release");
  });
});

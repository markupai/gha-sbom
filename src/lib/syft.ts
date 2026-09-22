import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "./digest.js";

const PLATFORMS: Record<string, string> = { linux: "linux", darwin: "darwin", win32: "windows" };
const ARCHES: Record<string, string> = { x64: "amd64", arm64: "arm64" };

export function assetName(version: string, platform: string, arch: string): string {
  const os = PLATFORMS[platform];
  const cpu = ARCHES[arch];
  if (!os || !cpu) throw new Error(`syft has no release for ${platform}/${arch}`);
  const v = version.replace(/^v/, "");
  return `syft_${v}_${os}_${cpu}.${os === "windows" ? "zip" : "tar.gz"}`;
}

/** Downloads a pinned syft release, checks it against the published checksums, and caches it. */
export async function installSyft(version: string): Promise<string> {
  const exe = process.platform === "win32" ? "syft.exe" : "syft";
  const v = version.replace(/^v/, "");
  const cached = tc.find("syft", v);
  if (cached) return path.join(cached, exe);

  const base = `https://github.com/anchore/syft/releases/download/v${v}`;
  const asset = assetName(v, process.platform, process.arch);
  const [archive, sums] = await Promise.all([
    tc.downloadTool(`${base}/${asset}`),
    tc.downloadTool(`${base}/syft_${v}_checksums.txt`),
  ]);

  const expected = (await readFile(sums, "utf8"))
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
  if (!expected) throw new Error(`${asset} is missing from the syft ${v} checksums`);
  const actual = (await sha256File(archive)).slice(7);
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}`);

  const dir = asset.endsWith(".zip") ? await tc.extractZip(archive) : await tc.extractTar(archive);
  const cachedDir = await tc.cacheDir(dir, "syft", v);
  core.info(`syft ${v} installed`);
  return path.join(cachedDir, exe);
}

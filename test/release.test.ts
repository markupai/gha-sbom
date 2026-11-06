import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const script = workflow.split("          script: |\n")[1];
if (!script) throw new Error("Release script not found");
const sha = "a".repeat(40);
const oldSha = "b".repeat(40);
type Tag = { name: string; commit: { sha: string } };
type Release = { draft: boolean; prerelease: boolean; html_url: string };

function fixture({
  tags = [{ name: "v1.2.2", commit: { sha: oldSha } }],
  main = sha,
  major = oldSha,
}: { tags?: Tag[]; main?: string; major?: string } = {}) {
  const releases = new Map<string, Release>();
  const refs = new Map<string, string>([["heads/main", main]]);
  if (major) refs.set("tags/v1", major);
  const missing = () => Object.assign(new Error("Not found"), { status: 404 });
  const git = {
    getRef: vi.fn(({ ref }: { ref: string }) => {
      const value = refs.get(ref);
      if (!value) throw missing();
      return { data: { object: { sha: value } } };
    }),
    createRef: vi.fn(({ ref, sha: target }: { ref: string; sha: string }) => {
      if (refs.has(ref.slice(5))) throw new Error("Ref already exists");
      refs.set(ref.slice(5), target);
      tags.push({ name: ref.slice("refs/tags/".length), commit: { sha: target } });
    }),
    updateRef: vi.fn(({ ref, sha: target }: { ref: string; sha: string }) => {
      refs.set(ref, target);
    }),
  };
  const repos = {
    listTags: vi.fn(),
    getReleaseByTag: vi.fn(({ tag }: { tag: string }) => {
      const release = releases.get(tag);
      if (!release) throw missing();
      return { data: release };
    }),
    generateReleaseNotes: vi.fn(() => ({ data: { body: "Generated notes" } })),
    createRelease: vi.fn(({ tag_name }: { tag_name: string }) => {
      const release = {
        draft: false,
        prerelease: false,
        html_url: `https://example.com/${tag_name}`,
      };
      releases.set(tag_name, release);
      return { data: release };
    }),
  };
  const paginate = vi.fn(() => [...tags]);
  const notice = vi.fn();
  const run = async () => {
    await (runInNewContext(`(async () => {\n${script}\n})()`, {
      github: { rest: { git, repos }, paginate },
      context: { repo: { owner: "markupai", repo: "gha-sbom" }, sha },
      core: { notice },
    }) as Promise<void>);
  };
  return { run, git, repos, refs, tags, releases, paginate };
}

describe("automatic releases", () => {
  it("gates releases on successful CI for pushes to main", () => {
    expect(workflow).toContain("needs: [check, actionlint, self-test]");
    expect(workflow).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}");
  });

  it("creates the next patch release at the tested SHA and moves v1", async () => {
    const f = fixture();
    await f.run();
    expect(f.paginate).toHaveBeenCalledWith(
      f.repos.listTags,
      expect.objectContaining({ per_page: 100 }),
    );
    expect(f.git.createRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "refs/tags/v1.2.3", sha }),
    );
    expect(f.repos.generateReleaseNotes).toHaveBeenCalledWith(
      expect.objectContaining({
        previous_tag_name: "v1.2.2",
        tag_name: "v1.2.3",
        target_commitish: sha,
      }),
    );
    expect(f.repos.createRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        tag_name: "v1.2.3",
        target_commitish: sha,
        name: "v1.2.3",
        body: "Generated notes",
        draft: false,
        prerelease: false,
        make_latest: "true",
        headers: { "X-GitHub-Api-Version": "2026-03-10" },
      }),
    );
    expect(f.refs.get("tags/v1")).toBe(sha);
  });

  it("is idempotent when rerun", async () => {
    const f = fixture();
    await f.run();
    await f.run();
    expect(f.git.createRef).toHaveBeenCalledOnce();
    expect(f.repos.createRelease).toHaveBeenCalledOnce();
  });

  it("recovers after creating the tag but failing to publish", async () => {
    const f = fixture();
    f.repos.createRelease.mockImplementationOnce(() => {
      throw new Error("API failure");
    });
    await expect(f.run()).rejects.toThrow("API failure");
    expect(f.git.updateRef).not.toHaveBeenCalled();
    await f.run();
    expect(f.git.createRef).toHaveBeenCalledOnce();
    expect(f.releases.has("v1.2.3")).toBe(true);
  });

  it("recovers when the major tag update fails after release creation", async () => {
    const f = fixture();
    f.git.updateRef.mockImplementationOnce(() => {
      throw new Error("Update failed");
    });
    await expect(f.run()).rejects.toThrow("Update failed");
    await f.run();
    expect(f.repos.createRelease).toHaveBeenCalledOnce();
    expect(f.refs.get("tags/v1")).toBe(sha);
  });

  it("skips a superseded run without any writes", async () => {
    const f = fixture({ main: oldSha });
    await f.run();
    expect(f.paginate).not.toHaveBeenCalled();
    expect(f.git.createRef).not.toHaveBeenCalled();
    expect(f.git.updateRef).not.toHaveBeenCalled();
    expect(f.repos.createRelease).not.toHaveBeenCalled();
  });

  it("sorts versions numerically and ignores floating and prerelease tags", async () => {
    const tags = ["v1.2.9", "v1.2.10", "v1", "v1.3.0-rc.1"].map((name) => ({
      name,
      commit: { sha: oldSha },
    }));
    const f = fixture({ tags });
    await f.run();
    expect(f.releases.has("v1.2.11")).toBe(true);
  });

  it("creates a missing major tag", async () => {
    const f = fixture({ major: "" });
    await f.run();
    expect(f.refs.get("tags/v1")).toBe(sha);
  });

  it("fails without an existing release line", async () => {
    const f = fixture({ tags: [] });
    await expect(f.run()).rejects.toThrow("bootstrap");
    expect(f.git.createRef).not.toHaveBeenCalled();
  });

  it("does not promote an existing draft release", async () => {
    const f = fixture({ tags: [{ name: "v1.2.3", commit: { sha } }] });
    f.releases.set("v1.2.3", {
      draft: true,
      prerelease: false,
      html_url: "https://example.com/draft",
    });
    await expect(f.run()).rejects.toThrow("Refusing to promote");
    expect(f.git.updateRef).not.toHaveBeenCalled();
  });
});

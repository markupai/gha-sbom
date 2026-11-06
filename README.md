# gha-sbom

Actions for generating, stamping, attesting and storing SBOMs in our release
pipelines (SRE-5175). Every release gets a CycloneDX SBOM plus an SPDX 2.3 copy,
traceable to its version, commit and image digest or artefact sha256, signed with
a GitHub artifact attestation and stored in `s3://markupai-sbom-archive`.

| Action                      | Type      | Does                                                                                  |
| --------------------------- | --------- | ------------------------------------------------------------------------------------- |
| `markupai/gha-sbom/image`   | composite | syft on an image **by digest**, skipped if that digest is already attested            |
| `markupai/gha-sbom/stamp`   | node      | checks the SBOM isn't empty, stamps traceability, writes the SPDX copy                |
| `markupai/gha-sbom/publish` | composite | `actions/attest`, S3 upload, GitHub Release assets, optional `snyk container monitor` |

Source SBOMs come from each ecosystem's own tool (cyclonedx-maven-plugin,
cyclonedx-npm, `pnpm sbom`, `uv export`/cyclonedx-py, dotnet-CycloneDX,
cyclonedx-gomod) run in the caller's job, then go through `stamp` and `publish`.

## Dependency updates

Renovate is configured in `.github/renovate.json` for GitHub Actions and npm
dependencies, with SHA-pinned actions, a seven-day action release cooldown and
grouped npm development-tool updates. npm updates that affect the bundled
actions also require `npm run package` and committing the resulting `dist/` changes.

The schedule lives in [markupai/renovate](https://github.com/markupai/renovate),
not this repository. Onboarding requires `gha-sbom` in both its App-token
repository list and Renovate allowlist, plus repository access for the
`markupai-renovatebot` GitHub App. Once enabled, pending updates appear in this
repository's Dependency Dashboard.

## Usage

Pin by full SHA with the version as a comment; Renovate keeps it current.

### Image

```yaml
permissions:
  contents: read
  packages: write # push-to-registry
  id-token: write # attestation and AWS OIDC
  attestations: write

steps:
  - id: image
    uses: markupai/gha-sbom/image@<sha> # v1.0.0
    with:
      image: ghcr.io/markupai/helios-one
      digest: ${{ steps.push.outputs.digest }}

  - id: stamp
    if: steps.image.outputs.skipped != 'true'
    uses: markupai/gha-sbom/stamp@<sha> # v1.0.0
    with:
      sbom: ${{ steps.image.outputs.sbom }}
      kind: image
      product: helios
      component: helios-one
      version: ${{ github.sha }}
      digest: ${{ steps.push.outputs.digest }}

  - if: steps.image.outputs.skipped != 'true'
    uses: markupai/gha-sbom/publish@<sha> # v1.0.0
    with:
      cdx: ${{ steps.stamp.outputs.cdx }}
      spdx: ${{ steps.stamp.outputs.spdx }}
      key: ${{ steps.stamp.outputs.key }}
      component: helios-one
      subject-name: ghcr.io/markupai/helios-one
      subject-digest: ${{ steps.stamp.outputs.digest }}
      push-to-registry: "true"
      bucket: ${{ vars.SBOM_BUCKET }}
      role-arn: ${{ vars.SBOM_ROLE_ARN }}
      snyk-image: ghcr.io/markupai/helios-one@${{ steps.stamp.outputs.digest }}
      snyk-token: ${{ secrets.SNYK_TOKEN }}
      snyk-tags: product=helios,component=helios-one,version=${{ github.sha }}
```

### Artefact (zip, vsix, nupkg, exe)

Run after any code signing so the recorded sha256 is what ships.

```yaml
- id: stamp
  uses: markupai/gha-sbom/stamp@<sha> # v1.0.0
  with:
    sbom: bom.json
    kind: source
    product: integrations
    component: figma-plugin
    version: ${{ github.ref_name }}
    subject-path: markup-ai-figma-plugin.zip
    min-components: "1"
    min-licence-pct: "80"

- uses: markupai/gha-sbom/publish@<sha> # v1.0.0
  with:
    cdx: ${{ steps.stamp.outputs.cdx }}
    spdx: ${{ steps.stamp.outputs.spdx }}
    key: ${{ steps.stamp.outputs.key }}
    component: figma-plugin
    subject-path: markup-ai-figma-plugin.zip
    bucket: ${{ vars.SBOM_BUCKET }}
    role-arn: ${{ vars.SBOM_ROLE_ARN }}
    release-tag: ${{ github.ref_name }} # needs contents: write
```

### Backfill

Same steps from a `workflow_dispatch` that checks out the release tag, with
`backfill: "true"` on `stamp`. The SBOM is marked as generated after the fact.

## What gets stamped

CycloneDX `metadata.properties` (and the SPDX `creationInfo.comment`):
`markupai:product`, `markupai:component`, `markupai:version`, `markupai:commit`,
`markupai:image-digest` or `markupai:sha256`, `markupai:sbom-kind`,
`markupai:s3-key`, `markupai:ci-run`, `markupai:backfill`.

## S3 layout

```
<product>/<component>/<version>/sha256-<hex>/{source,image}.{cdx,spdx}.json
<product>/_releases/<version>/release.{cdx,spdx}.json
_selftest/gha-sbom/run-<id>/...
```

Per-component SBOMs are keyed by digest, so rebuilding a version never
overwrites an earlier one, and the key names what you verify against.

A release index (`kind: release`) lists every component in a release with its
digest, so one GET answers "everything in SLS v0.29.0" without knowing the
component names. It takes no digest of its own. Build it by merging the
per-component BOMs (`cyclonedx merge --hierarchical`), then stamp with
`kind: release`.

## Guards

- `min-components` fails the step. Generators can succeed with an empty or partial
  BOM (the Maven plugin does without GitHub Packages auth).
- `min-licence-pct` warns. Lockfile-only generators carry no licence data.
- A failed `snyk container monitor` warns rather than fails. It runs last, after the
  SBOM is attested and in S3.
- Deprecated SPDX licence ids (e.g. `GPL-2.0-with-classpath-exception`) are rewritten
  so the SPDX copy passes strict validation.

## Access

Public, so public repos such as vscode-extension-sidebar can use the actions too.
Nothing here is secret: the bucket and role come from org variables at the call
site, and only the role's trust policy decides who can write.

## Development

```bash
npm ci
npm run all
```

`dist/` is committed and CI fails if it's stale.

## Releases

The existing CI workflow publishes a GitHub Release after a push to `main`
passes checks, actionlint and all three self-test runners. It tags the exact
validated commit with the next patch version in the v1 line, generates release
notes since the previous version tag, and moves the floating `v1` tag to it.
Version tags are never moved. The version comes from Git tags, not the private
npm package's `version` field; there is no npm publish step.

PR runs and manual workflow dispatches do not release. Re-running a failed main
push run recovers partial publication without allocating another version. Main
runs are not cancelled in progress; superseded commits skip publication so the
newest successful main run releases the accumulated changes. If that run fails,
no new release is published until CI passes.

Every successful eligible main push gets a patch release, including maintenance
changes. For an intentional minor release, create the new v1 minor version tag
on the tested main commit before re-running that push run; automation will use
that tag and subsequent releases will increment its patch. A breaking v2 release
requires updating the release-line policy before merging breaking changes.
SHA-pinned consumers still need a Renovate PR or manual pin update.

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

S3 layout: `<product>/<component>/<version>/sha256-<hex>/{source,image}.{cdx,spdx}.json`.

## Guards

- `min-components` fails the step. Generators can succeed with an empty or partial
  BOM (the Maven plugin does without GitHub Packages auth).
- `min-licence-pct` warns. Lockfile-only generators carry no licence data.
- Deprecated SPDX licence ids (e.g. `GPL-2.0-with-classpath-exception`) are rewritten
  so the SPDX copy passes strict validation.

## Access

Internal repo, Actions access set to the markupai organisation. Public repos can't
use internal actions, so vscode-extension-sidebar carries a vendored copy.

## Development

```bash
npm ci
npm run all
```

`dist/` is committed and CI fails if it's stale. Release with a semver tag and move
the major tag (`v1`).

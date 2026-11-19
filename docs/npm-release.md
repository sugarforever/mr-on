# npm installation and releases

Requires Node.js >=22.19.0. This document describes installation after publication; adding the release workflow does not itself publish to npm.
The npm package is `@verysmallwoods/mron`, and its installed command is `mron`. The unscoped `mron` name is owned by another maintainer. The GitHub repository, existing data directories, and service identifiers retain mr-on for compatibility with existing data and services.

```sh
npm install -g @verysmallwoods/mron
mron --help
mron start
# Pinned installation / one-time foreground trial
npm install -g @verysmallwoods/mron@0.1.0
npx @verysmallwoods/mron@latest
```

By default, the command runs in the foreground, listening only locally on port 4317. Set `PORT` to change the port.
Use `mron service --help` and `mron client --help` to inspect commands.
Run `mron onboard` to configure the model and optionally install the background service; `mron configure` changes model settings only. See [terminal onboarding](onboarding.md) and [background service](gateway-service.md).

Data-path precedence for all packaged commands: `--data PATH` > `MR_ON_DATA` > `~/.mr-on`.
Relative paths resolve against the startup working directory. Keep data outside the npm installation directory and npx cache.
Existing repository scripts `npm run start`, `npm run client`, and `npm run service` retain their `.data` behavior.
Existing users should explicitly supply their original directory, for example `mron start --data /absolute/path/to/mr-on/.data`;
old databases are not automatically migrated or selected. Stop the original gateway and back up data first; do not copy live SQLite files.
Model credentials in SQLite are **not encrypted**. Preserve directory/file permissions and treat backups as sensitive data.

Before removing the package, stop and uninstall its user service, then run `npm uninstall -g @verysmallwoods/mron`.
Removing the npm package does not delete `~/.mr-on` or an explicitly selected data directory.
See [service documentation](gateway-service.md) for upgrades, absolute Node paths, and reinstallation precautions.

## Automated release flow

After changes merge into `main`, `.github/workflows/release.yml` uses release-please to create or update a version PR, maintaining package.json, package-lock.json, CHANGELOG, and the version manifest. Use Conventional Commits, such as `feat: add a capability` or `fix: correct a failure`. During 0.x, features increment minor and fixes increment patch. The manifest starts at 0.1.0; history before the bootstrap commit is not repeated in release notes.

release-please uses the built-in GITHUB_TOKEN and needs no GitHub App, App private key, or PAT. A version PR created by that token cannot be relied on to trigger pull_request CI automatically and may need human approval, so the workflow explicitly dispatches the existing ci.yml on the version PR branch. Results match the same head commit. GITHUB_TOKEN can trigger workflow_dispatch. The version PR must pass the existing Merge gate and be merged by a maintainer. release-please then creates a `vX.Y.Z` tag and GitHub Release; the stage job in the same workflow validates that tagged commit, not later main commits. A GitHub Release and a successful stage job do not establish npm publication: a maintainer must approve the staged package on npm with 2FA.

The stage job rejects unstable versions, tags outside main history, and versions whose package.json/lockfile disagree with the tag. It runs the build, unit tests, demo, formatting/browser syntax checks, dependency audit, and browser tests, then builds a tarball. `MR_ON_TARBALL` makes the package test install and verify that tarball; npm subsequently stages the same file with lifecycle scripts disabled. Staging uses Node 24, npm >=11.15.0, and OIDC, without NPM_TOKEN or an npm cache for the release build. Only stable releases targeting latest are supported, not beta/next. The tag is applied when the staged package is approved; staging alone does not change the public latest version.

### One-time setup

1. In repository Settings → Actions → General → Workflow permissions, enable Allow GitHub Actions to create and approve pull requests. The release job explicitly requests Contents, Pull requests, Issues, and Actions write permissions; repository and organization policies must allow these. It only creates version PRs and explicitly triggers CI; it does not automatically approve or merge PRs.
2. No RELEASE_APP_ID, RELEASE_APP_PRIVATE_KEY, or GitHub environment is required. Previously configured values are no longer used by the workflow.
3. Confirm the npm package name and account permissions. The package already exists. For a future new package, create it through the manual staging flow below, then configure its Trusted Publisher. release-please manages later versions.
4. In the package's Trusted publishing settings, select GitHub Actions and bind owner `sugarforever`, repository `mr-on`, and workflow filename `release.yml`; leave environment blank, disable **Allow npm publish**, and retain stage-only access. Leave **Allow npm dist-tag** disabled; the workflow does not need it. Names must match exactly. Use a GitHub-hosted runner. A new npm trust configuration must complete its first successful publication within npm's documented validity period; otherwise recreate it.
5. In npm Publishing access, select **Require two-factor authentication and disallow tokens**. Keep 2FA enabled and remove obsolete bypass/automation tokens. OIDC staging remains available without a long-lived token.
6. Retain main's PR review and Merge gate protection, and restrict release-tag creation/modification. After approval of the first staged release, verify the npm version and provenance. Keep npm approval outside Actions; never automate `npm stage approve` or store a maintainer approval credential in CI.

### Failures and retries

If publication is interrupted or initial setup is incomplete, choose Run workflow in the Actions Release workflow, select main, and enter an existing tag (for example `v0.2.0`). This retries validation and staging for that tag without generating a new version. You can also rerun the original failed job. The tag must include this release workflow and validation script; do not use this entry point for an older bootstrap tag.

Staged and published versions share the same version namespace. Before retrying, use the npm website or a maintainer session with `npm stage list @verysmallwoods/mron` to check whether staging already succeeded; the CI OIDC token cannot list, view, or approve staged packages. Do not blindly re-stage a pending version. Published versions cannot be overwritten. If it is already published, verify the result without moving tags or force-pushing versions. If code needs fixing, commit the fix and release a new version. Do not use direct publication as a fallback. A staging failure does not automatically delete the GitHub Release.

### Review and approve a staged release

After the stage job succeeds, wait for npm scanning to finish. In the npm Staged Packages page, or from a logged-in maintainer terminal:

```sh
npm stage list @verysmallwoods/mron
npm stage view <stage-id>
npm stage download <stage-id>
```

Check the package name, version, intended `latest` tag, source commit, provenance, and staged contents. Compare the downloaded tarball's SHA-256 with the stage job summary. Downloading does not install or execute it. Reject unexpected contents rather than approving a version based only on a green CI status.

Approve the intended stage on npm, or run the following yourself and complete the 2FA challenge:

```sh
npm stage approve <stage-id>
```

This is the step that makes the version public. Actions never performs it. After approval and processing, verify registry metadata, provenance, and installation from a temporary directory without source code.

### Manual bootstrap or emergency staging

For a new package, staged publishing creates a publicly visible `0.0.0-stage` placeholder; the candidate package contents stay private until approval. Use the same review/approval process rather than enabling direct publishing or weakening token restrictions. Run the normal build, test, audit, browser, and package checks first:

```sh
npm ci
npm run build
npm test
npm run demo
npm run format:check
npm run check:browser
npx playwright install chromium
npm run test:ui
npm audit --audit-level=high
mkdir -p release-artifacts
npm pack --json --pack-destination release-artifacts
# Substitute the filename produced by npm pack.
MR_ON_TARBALL="$PWD/release-artifacts/verysmallwoods-mron-VERSION.tgz" npm run test:package
npm stage publish "$PWD/release-artifacts/verysmallwoods-mron-VERSION.tgz" --access public --tag latest --ignore-scripts
```

Inspect the tarball file list and test results before staging. Keep tokens out of arguments, logs, and PRs. For a new package, configure its Trusted Publisher after package creation. Use npm >=11.15.0 for all stage commands.

References: [release-please](https://github.com/googleapis/release-please-action), [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/), [staged publishing](https://docs.npmjs.com/staged-publishing/).

The explicit files allowlist excludes development-test artifacts. Runtime dependencies are still resolved and installed by npm;
this is not a dependency-free binary. The Pi SDK has transitive dependencies for multiple providers. Recheck dependency audits and license inventories for every release.
The non-development license fields in the lockfile inspected for the initial release were: MIT 132, Apache-2.0 38, BlueOak-1.0.0 4,
BSD-3-Clause 14, ISC 11, BSD-2-Clause 10, Unlicense 1, 0BSD 1,
with no missing fields. This was a metadata check; review actual licenses and redistribution obligations before publication.

Package verification does not establish real-model compatibility or completion of real launchd/systemd lifecycle testing.

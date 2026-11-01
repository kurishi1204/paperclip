# COLO source artifact

This is the source transport contract for `kurishi1204/paperclip`. The workflow
runs on pull requests and master pushes with read-only repository permissions.
It does not publish npm packages, Docker images or AWS artifacts. Existing upstream
distribution workflows and their failures remain separate.

A successful job runs transport tests and the adopted CI resolution-only lockfile
step. It freezes a history-free Git object pack and the resolved dependency lock
before dependency install or build. It restores that package into a fresh directory,
runs `pnpm install --frozen-lockfile` and the normal build there, then verifies the
original package and installed lock against the pre-install receipt. This tests
the received source itself rather than only building the checkout used to pack it.

The uploaded package has exactly three files: `source-objects.pack`,
`resolved-pnpm-lock.yaml` and `manifest.json`. Retention is 30 days. The successful
job summary records the full commit and manifest SHA-256. Save that receipt with
the download if longer retention is needed. A checksum identifies bytes; it does
not authenticate an operator or prove adoption.

Select a successful run and its exact commit. A PR artifact is a candidate.
Service updates still require normal checks, the repository review gate, adoption
and operator permission. Run the following from trusted adopted verifier code,
using the expected manifest hash from the selected run summary:

```sh
node scripts/colo-source-artifact.mjs verify DOWNLOAD_DIRECTORY FULL_COMMIT EXPECTED_MANIFEST_SHA256
node scripts/colo-source-artifact.mjs restore DOWNLOAD_DIRECTORY FULL_COMMIT EXPECTED_MANIFEST_SHA256 NEW_DIRECTORY
```

Verification checks the receipt-bound manifest, exact file inventory, checksums,
expected Git commit/tree, and complete object inventory. Only that commit and its
tree objects are allowed; unrelated objects and parent history are rejected.
Submodule sources are unsupported and rejected. Local files, databases,
node_modules and build outputs do not enter the pack unless committed to Git.

Restore verifies before creating the destination, requires a new directory, and
uses Git's standard index checkout with empty templates and no system/global Git
configuration. It does not execute source hooks or package scripts. Committed
`export-ignore` and `export-subst` attributes cannot remove or rewrite files as
they can with `git archive`. Normal Git checkout line-ending rules still apply.
The source Git objects remain exact. The repository is shallow at the selected
commit. Its working `pnpm-lock.yaml` is explicitly replaced by the verified
resolved lock; the original committed lock remains in Git. Do not commit this
resolved lock. Existing output directories are never overwritten.

This is source, not a portable prebuilt runtime or a database/authentication backup.
The target needs Node 24.11+, pnpm 9.15.4 and the Rust toolchain declared in
`packages/paperclip-runner/rust-toolchain.toml`. On the target, enter the restored
directory, install frozen dependencies and run the normal build. Retain and verify
local service state, authentication, database compatibility and active-run
continuity under the service's update procedure. This workflow does not stop,
restart, migrate or otherwise change a running service.

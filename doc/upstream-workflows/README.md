# Upstream release workflow reference

These files are byte-preserved references for the upstream
`paperclipai/paperclip` release infrastructure. They are outside
`.github/workflows` deliberately. They do not register runnable workflows in
the COLO fork.

The COLO fork distributes its adopted source through
`.github/workflows/colo-source-artifact.yml`. Normal pull-request CI and that
source artifact workflow remain active. This change does not enable npm,
container-registry, AWS, or upstream lockfile publication.

GitHub validates action references before evaluating the repository conditions
on upstream jobs. Consequently the old upstream jobs failed at startup in the
fork even though their `paperclipai/paperclip` repository condition was false.
Keeping their definitions here avoids those invalid registrations without
weakening the fork's existing action allowlist or immutable-SHA requirement.

The release-library, preview-artifact, and migrator tests continue to read these
preserved definitions. Their assertions and the upstream release scripts are
unchanged. Restoring an upstream workflow to `.github/workflows` is a separate
publication decision that requires checking its destinations, credentials,
action policy, and triggers first.

The byte-preserved `docker-runner-manual.yml` reference contains the original upstream manual image/EC2 qualification definition. The active `docker-runner-check.yml` retains its original pull-request native Docker build job. It has no manual publication jobs or credentials. This separates the fork CI result from upstream-only skipped jobs without changing the native build or the action allowlist.

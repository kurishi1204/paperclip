# Fixed document QA through the dedicated task tool

An employee could discover the interaction REST endpoint but could not create a named document review through it: generic `call_api` deliberately rejects interaction mutations. The dedicated `request_human_input` tool did not accept or forward a reviewer, so callers fell back to separate review tasks.

For standard/planning tasks the dedicated tool now accepts an optional `addresseeAgentId` on a confirmation bound to the exact saved current-task documentId/key/revisionId. The normal interaction service still checks company membership, independent/invokable addressee, current document identity and resolver governance. It receives no caller-supplied or synthesized resolver-policy override. Governed actions, ordinary human questions and Ask mode cannot use the named-review option. Existing human-only decisions keep their resolver restriction. Generic REST creation and decision escapes remain denied.

The scenario simulator does not implement live employee review dispatch. It returns an explicit unsupported result for a named reviewer instead of silently creating a human card without that reviewer. Live/scenario descriptors and generated catalog/contract projections are updated through their normal generators.

Qualification keeps old failed attempts, tests the actual saved addressee against the old authority, and exercises the real isolated database/HTTP fixture. Production acceptance still requires same-head independent review, normal CI/build and an actual existing-employee fixed-version QA handoff; local checks alone do not complete it.

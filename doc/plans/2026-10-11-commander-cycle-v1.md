# Commander cycle v1

## Scope and authority

This contract covers selecting and dispatching an existing, explicitly admitted company task. It does not create tasks, change permissions, approve QA, or supply owner acceptance. Paperclip company goals remain the business plan; Linear/Orca retain planning and execution tracking. A completed task is never a candidate.

The board configures `commanderCycleToolsOnly: true` and `commanderCyclePolicy` on the existing commander. Every admission records an immutable admission UUID, company/task/worker identities, issue revision and status version, exact description SHA-256 and expiry. Issuing an admission authorizes its bounded metadata to be used for model selection and its specified worker to execute the existing approved task. Changes require a fresh admission, not an implicit retry. The commander identity must match the policy.

## Execution contract

1. The server reads company issue state and builds a snapshot. Only current admissions for `todo` tasks assigned to the specified worker are eligible. Other tasks are excluded without revealing their bodies.
2. A disposable managed Claude or sealed Codex HOME and working directory are used. No inherited host environment, task instructions, skills, session resume, custom arguments, Chrome, shell, MCP servers, run token or provider-controlled API route is provided. The commander receives only the server-built snapshot and returns one strict JSON selection or idle.
3. A selection is a proposal. The normal wake queue locks the selected issue and rechecks current commander policy, expiry, revision, status version, body hash, assignment, parent run and active child runs. Existing admission receipts are reused. A stopped parent or revoked admission fails closed.
4. The normal worker executes the task. Existing independent QA and owner approval stages remain separate. Commander receipt records a queued/reused Run or held/idle; it never claims execution or business acceptance.
5. Periodic commander execution uses a single concurrent run and the normal Paperclip timer. A timer registration is accepted only after a real scheduled cycle and its resulting dispatch/worker/QA states are read back. Enabling a timer is not business acceptance.

## Initial commissioning

The prior commander instructions allowed only an initial tool-free probe. Replace them with this normal-cycle contract after adoption and live isolation proof. The completed company business task must not be executed again; unadmitted initial onboarding/probe tasks remain excluded. Choose one bounded public-source company task only after checking duplicates and its business scope, then configure one expiring admission and its existing review/owner stages. Read back one commander selection, actual worker result, independent QA and owner acceptance separately before regular operation is declared.

Claude Code was probed again with a generic public architecture prompt and tools disabled. It returned `is_error: true` and a weekly-limit response. The requested model was `claude-opus-5-5`; no executed model ID or completed Claude plan was observed. This versioned implementation plan was prepared by the current Codex session under the user's authorized fallback. Its exact model ID is unavailable in this tool context. Commissioning uses the connected OpenAI subscription and the existing root-sealed Codex executable. The existing QA MCP tools are not supplied to commander mode. Model-facing pure evaluation/coordination wrappers can remain; this is not a claim that every visible wrapper is absent. The sealed executor and empty MCP configuration carry no authorized host or company callback.

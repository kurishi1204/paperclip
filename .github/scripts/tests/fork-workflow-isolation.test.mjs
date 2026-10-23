import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

// This policy runs before dependency installation. Each source pin covers the
// complete workflow, so a new job or a changed dependency cannot bypass the
// reviewed entry-job inventory by using a different YAML spelling.
const workflowDir = new URL('../../workflows/', import.meta.url);
const sourcePins = {
  'agent-runtime-images.yml': 'f5545e5026b260939a60d84a7362487123bd5196aecd09edbba8aed7c91614e8',
  'cloud-migrator-artifacts.yml': 'e3f8b842e6bccc9e037417d1c1028161aa6974cfa1994bd041e07bfe98d8e672',
  'cloud-readiness.yml': '6fa94435fcf0524e50f4d883fa08fd3d59d8f42344cdda28718f1fa212ab84c2',
  'commitperclip-review.yml': 'a99c5dcfc4e22bc697b163a95a2121a4854636212c7757e148bdfb7f7cfeba37',
  'docker-runner-check.yml': 'ca484e72732dc8f6417a5cdb3968238c6f74ea455a3acaa8acd07a2c76811f00',
  'docker.yml': '27988c53e451e602a5e35fdf857aca98aac48fa120d2d94f3457467311808ca3',
  'e2e.yml': 'd8a00ab355a4e9304a9a8a28d6aa1fdb816f9130bff244c91d4d59a5453fde85',
  'pr-trusted.yml': '4591cb206275d8ffa8420045b028719e6bf066fc1f262cdde3c578b063150f27',
  'pr.yml': ['2025e2b8fefb37dd515aef7d671ba725f74ffa3b86e5177ddfae7c3ad21e7163', '72faa9ad764b798a73e89684317f3bc9a73d3ba009a9343e621801e2ba4c6bfe'],
  'refresh-lockfile.yml': 'c092cf9bf08d548157a84dc9d28ab0ec44ca14969b12315c10db4a2ce5cde20f',
  'release-smoke.yml': 'c3a05e16db09958896388d2bd2c61a9928c69fd0c33563d81854ac9637944ae3',
  'release-verify.yml': '0edca442132245dd04aa18be9cc80165f923f9c6a502227008b9afbdc4e8f5fd',
  'release.yml': '0fd3f63a1ac615a8ecf9bde1f3d7ba096c51e1179325664ce2a6144d62250b52',
  'runner-chaos-evals.yml': 'c2f621386d0016ff6b3bb8982ba025e27c6612623d8664905b14c753aefe162f',
  'runner-full-stack-e2e.yml': '776dc69480f59f48a8e5178a84a79e78aff277d47adf4ec8e723dd0ffb845821',
  'runner-live-evals.yml': 'b7699d9a8dff92ca603ad55481c2b85328c42a521b1627b12762dc859d80c2d6',
  'runner-protocol-live-evals.yml': '753df37272526daa8f3faf5109efb7f91cca5be9fc026c419f1a14db23e3e254',
  'sentry-contract.yml': '54756ab2ab2ae811ca2b32e666a5593ff88d0c59b4473c84be78769a0a09b834',
  'storybook-deploy.yml': '5956098ee87e89d94af6477c07a866c9730765243423e18ef5807b9a82bdbbb1',
  'storybook-visual.yml': 'ae32984f21b388837586d2b20fa4db8f14fde849110406c63fb92918737b9d71',
};
const guard = "github.repository == 'paperclipai/paperclip' && github.repository_id == '1170821064'";
const guardedRoots = {
  'agent-runtime-images.yml': { 'build-and-sign': null },
  'commitperclip-review.yml': { review: null },
  'docker-runner-check.yml': { authorize_manual: "github.event_name == 'workflow_dispatch'" },
  'docker.yml': { 'build-and-push': null },
  'e2e.yml': { authorize: null },
  'refresh-lockfile.yml': { refresh: null },
  'release-smoke.yml': { smoke_service: null, smoke: null },
  'release.yml': {
    plan_preview: "github.ref == 'refs/heads/master' && github.event_name == 'workflow_dispatch' && (inputs.channel == 'preview' || inputs.channel == 'cloud-migrator') && !inputs.dry_run",
    select_nightly: "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.channel == 'nightly')",
    select_beta: "github.event_name == 'workflow_dispatch' && inputs.channel == 'beta'",
    preflight_stable: "github.event_name == 'workflow_dispatch' && inputs.channel == 'stable'",
  },
  'runner-chaos-evals.yml': { chaos_and_recovery: null },
  'runner-full-stack-e2e.yml': { authorize: "github.event_name != 'schedule' || vars.RUNNER_FULL_STACK_E2E_NIGHTLY_ENABLED == 'true'" },
  'runner-live-evals.yml': { authorize: "github.event_name != 'schedule' || vars.RUNNER_LIVE_EVALS_NIGHTLY_ENABLED == 'true'" },
  'runner-protocol-live-evals.yml': { authorize: "github.event_name != 'schedule' || vars.RUNNER_PROTOCOL_EVAL_NIGHTLY_ENABLED == 'true'" },
  'storybook-deploy.yml': { authorize: null },
  'storybook-visual.yml': { preview: "github.event_name == 'workflow_dispatch' && inputs.deploy_preview" },
};

const reviewedFiles = [
  'agent-runtime-images.yml', 'cloud-migrator-artifacts.yml', 'cloud-readiness.yml',
  'commitperclip-review.yml', 'docker-runner-check.yml', 'docker.yml', 'e2e.yml',
  'pr-trusted.yml', 'pr.yml', 'refresh-lockfile.yml', 'release-smoke.yml',
  'release-verify.yml', 'release.yml', 'runner-chaos-evals.yml',
  'runner-full-stack-e2e.yml', 'runner-live-evals.yml',
  'runner-protocol-live-evals.yml', 'sentry-contract.yml',
  'storybook-deploy.yml', 'storybook-visual.yml',
];

function source(file) {
  return readFileSync(new URL(file, workflowDir));
}

function jobBody(file, name) {
  const text = source(file).toString('utf8');
  const start = text.indexOf('\njobs:\n');
  assert.notEqual(start, -1, `${file}: jobs block absent`);
  const lines = text.slice(start + 1).split('\n');
  const key = `  ${name}:`;
  const index = lines.findIndex((line) => line === key);
  assert.notEqual(index, -1, `${file}:${name}: job absent or changed shape`);
  const next = lines.findIndex((line, i) => i > index && /^  [\w-]+:$/.test(line));
  return lines.slice(index + 1, next === -1 ? undefined : next);
}

test('all 20 reviewed workflow files are present, with no new workflow', () => {
  const actual = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name)).sort();
  assert.deepEqual(actual, reviewedFiles.toSorted());
});

test('the pinned reusable PR workflow is the adopted 489b blob', () => {
  const bytes = source('pr-trusted.yml');
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(blob, '78911c1deca6832502cd2127798812071415205c');
});

for (const [file, jobs] of Object.entries(guardedRoots)) {
  for (const [name, original] of Object.entries(jobs)) {
    test(`${file}:${name} preserves its original condition behind the canonical guard`, () => {
      const body = jobBody(file, name);
      const conditions = body.filter((line) => line.startsWith('    if: '));
      const expected = original === null ? guard : `${guard} && (${original})`;
      assert.deepEqual(conditions, [`    if: ${expected}`]);
    });
  }
}

test('every reviewed workflow retains its exact source bytes', () => {
  assert.deepEqual(Object.keys(sourcePins).sort(), reviewedFiles.toSorted());
  for (const file of reviewedFiles) {
    const actual = createHash('sha256').update(source(file)).digest('hex');
    const expected = sourcePins[file];
    if (file === 'pr.yml') {
      // The second byte pin is the proposed later immutable-caller change. It
      // does not apply that change or authorize its deployment.
      assert.ok(Array.isArray(expected) && expected.includes(actual), `${file}: unreviewed source`);
    } else {
      assert.equal(actual, expected, `${file}: unreviewed source`);
    }
  }
});

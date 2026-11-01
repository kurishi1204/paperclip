import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { packSource, verifySource } from './colo-source-artifact.mjs';

function digest(output) {
  return createHash('sha256').update(readFileSync(path.join(output, 'manifest.json'))).digest('hex');
}

function fixture(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'colo-source-artifact-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(path.join(root, 'source.txt'), 'first\n');
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    git('add', 'source.txt', 'pnpm-lock.yaml');
    git('commit', '--quiet', '-m', 'fixture');
    fn({ root, git, commit: git('rev-parse', 'HEAD'), output: path.join(root, 'output') });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('fixed Git bytes round-trip; local changes and secrets are excluded', () => fixture(({ root, git, commit, output }) => {
  writeFileSync(path.join(root, '.env'), 'SYNTHETIC_SECRET=not-real\n');
  writeFileSync(path.join(root, 'source.txt'), 'uncommitted\n');
  const manifest = packSource(root, output, commit);
  const expected = digest(output);
  assert.equal(verifySource(output, commit, expected).verified, true);
  const tar = path.join(root, 'source.tar');
  writeFileSync(tar, gunzipSync(readFileSync(path.join(output, manifest.archive))));
  const entries = execFileSync('tar', ['-tf', tar], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(entries, [`paperclip-${commit}/`, `paperclip-${commit}/pnpm-lock.yaml`, `paperclip-${commit}/source.txt`]);
  assert.equal(execFileSync('tar', ['-xOf', tar, `paperclip-${commit}/source.txt`], { encoding: 'utf8' }), 'first\n');
}));

test('archive mutation is rejected', () => fixture(({ root, commit, output }) => {
  const m = packSource(root, output, commit);
  const expected = digest(output);
  writeFileSync(path.join(output, m.archive), 'corrupt');
  assert.throws(() => verifySource(output, commit, expected), /checksum/);
}));

test('manifest cannot select an outside path', () => fixture(({ root, commit, output }) => {
  const m = packSource(root, output, commit);
  const expected = digest(output);
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ ...m, archive: '../outside' }));
  assert.throws(() => verifySource(output, commit, expected), /checksum/);
}));

test('a coherent manifest cannot replace the trusted checksum', () => fixture(({ root, commit, output }) => {
  const m = packSource(root, output, commit);
  const expected = digest(output);
  const changed = Buffer.from('changed');
  writeFileSync(path.join(output, m.archive), changed);
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ ...m, bytes: changed.length,
    sha256: createHash('sha256').update(changed).digest('hex') }));
  assert.throws(() => verifySource(output, commit, expected), /checksum/);
}));

test('a different commit is rejected even with a matching archive hash', () => fixture(({ root, git, commit, output }) => {
  const m = packSource(root, output, commit);
  const expected = digest(output);
  writeFileSync(path.join(root, 'source.txt'), 'second\n');
  git('commit', '-am', 'second', '--quiet');
  const other = git('rev-parse', 'HEAD');
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ ...m, commit: other,
    archive: `paperclip-source-${other}.tar.gz`, prefix: `paperclip-${other}/` }));
  writeFileSync(path.join(output, `paperclip-source-${other}.tar.gz`), readFileSync(path.join(output, m.archive)));
  rmSync(path.join(output, m.archive));
  assert.throws(() => verifySource(output, other, digest(output)), /commit mismatch/);
}));

test('missing expected checksum and abbreviated commit are rejected', () => fixture(({ root, commit, output }) => {
  const m = packSource(root, output, commit);
  const expected = digest(output);
  assert.throws(() => verifySource(output, commit), /trusted manifest/);
  assert.throws(() => packSource(root, output, commit.slice(0, 7)), /full commit/);
  assert.equal(m.prebuiltRuntime, false);
}));

test('previous pack evidence is not overwritten', () => fixture(({ root, commit, output }) => {
  const m = packSource(root, output, commit);
  const expected = digest(output);
  assert.throws(() => packSource(root, output, commit), /EEXIST/);
  assert.equal(verifySource(output, commit, expected).verified, true);
}));

test('resolved lock bytes are bound and mutation is rejected', () => fixture(({ root, commit, output }) => {
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# CI resolution\n');
  const m = packSource(root, output, commit);
  const expected = digest(output);
  assert.equal(verifySource(output, commit, expected).dependencyLockSHA256, m.dependencyLock.sha256);
  writeFileSync(path.join(output, 'resolved-pnpm-lock.yaml'), 'changed');
  assert.throws(() => verifySource(output, commit, expected), /lock checksum/);
}));

test('large archives verify without piping the full tar to the header reader', () => fixture(({ root, git, output }) => {
  writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024, 65));
  git('add', 'large.txt');
  git('commit', '--quiet', '-m', 'large archive');
  const commit = git('rev-parse', 'HEAD');
  packSource(root, output, commit);
  assert.equal(verifySource(output, commit, digest(output)).verified, true);
}));


test('changed tar contents with a coherent digest still fail the Git tree check', () => fixture(({ root, commit, output }) => {
  const m = packSource(root, output, commit);
  const tar = gunzipSync(readFileSync(path.join(output, m.archive)));
  const offset = tar.indexOf(Buffer.from('first\n'));
  assert.ok(offset > 0);
  Buffer.from('wrong\n').copy(tar, offset);
  const changed = gzipSync(tar);
  writeFileSync(path.join(output, m.archive), changed);
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ ...m, bytes: changed.length,
    sha256: createHash('sha256').update(changed).digest('hex') }));
  assert.throws(() => verifySource(output, commit, digest(output)), /expected Git tree/);
}));

test('extra output files are rejected by both pack and verify', () => fixture(({ root, commit, output }) => {
  const m = packSource(root, output, commit);
  const expected = digest(output);
  writeFileSync(path.join(output, 'extra.txt'), 'unexpected');
  assert.throws(() => packSource(root, output, commit), /EEXIST/);
  assert.throws(() => verifySource(output, commit, expected), /Unexpected source artifact files/);
  rmSync(path.join(output, m.archive));
  rmSync(path.join(output, 'manifest.json'));
  rmSync(path.join(output, 'resolved-pnpm-lock.yaml'));
  rmSync(path.join(output, 'source-objects.pack'));
  // Even without any expected file, an existing directory cannot be reused.
  assert.throws(() => packSource(root, output, commit), /EEXIST/);
}));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { packSource, verifySource, restoreSource } from './colo-source-artifact.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (output) => hash(readFileSync(path.join(output, 'manifest.json')));
function fixture(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'colo-source-artifact-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '--quiet'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(path.join(root, 'source.txt'), 'first\n');
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    git('add', 'source.txt', 'pnpm-lock.yaml'); git('commit', '--quiet', '-m', 'fixture');
    fn({ root, git, commit: git('rev-parse', 'HEAD'), output: path.join(root, 'output'), restored: path.join(root, 'restored') });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('restore uses fixed Git source and excludes local changes and secrets', () => fixture(({ root, commit, output, restored }) => {
  writeFileSync(path.join(root, '.env'), 'SYNTHETIC_SECRET=not-real\n');
  writeFileSync(path.join(root, 'source.txt'), 'uncommitted\n');
  const m = packSource(root, output, commit);
  assert.equal(m.prebuiltRuntime, false);
  assert.equal(restoreSource(output, commit, digest(output), restored).restored, true);
  assert.equal(readFileSync(path.join(restored, 'source.txt'), 'utf8'), 'first\n');
  assert.equal(existsSync(path.join(restored, '.env')), false);
  assert.equal(execFileSync('git', ['-C', restored, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), commit);
  assert.equal(execFileSync('git', ['-C', restored, 'status', '--porcelain'], { encoding: 'utf8' }), '');
}));

test('export-ignore and export-subst do not omit or rewrite restored source', () => fixture(({ root, git, output, restored }) => {
  writeFileSync(path.join(root, '.gitattributes'), 'package.json export-ignore\nsource.txt export-subst\n');
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(path.join(root, 'source.txt'), '$Format:%H$\n');
  git('add', '.gitattributes', 'package.json', 'source.txt'); git('commit', '--quiet', '-m', 'export attributes');
  const commit = git('rev-parse', 'HEAD'); packSource(root, output, commit);
  restoreSource(output, commit, digest(output), restored);
  assert.equal(JSON.parse(readFileSync(path.join(restored, 'package.json'))).name, 'fixture');
  assert.equal(readFileSync(path.join(restored, 'source.txt'), 'utf8'), '$Format:%H$\n');
}));

test('object mutation is rejected before restore creates output', () => fixture(({ root, commit, output, restored }) => {
  packSource(root, output, commit); const expected = digest(output);
  writeFileSync(path.join(output, 'source-objects.pack'), 'corrupt');
  assert.throws(() => restoreSource(output, commit, expected, restored), /checksum/);
  assert.equal(existsSync(restored), false);
}));

test('manifest cannot select an outside path even with an expected digest', () => fixture(({ root, commit, output }) => {
  const m = packSource(root, output, commit);
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ ...m, gitObjects: { ...m.gitObjects, file: '../outside' } }));
  assert.throws(() => verifySource(output, commit, digest(output)), /identity mismatch/);
}));

test('a coherent manifest cannot replace the trusted checksum', () => fixture(({ root, commit, output }) => {
  const m = packSource(root, output, commit); const expected = digest(output); const changed = Buffer.from('changed');
  writeFileSync(path.join(output, 'source-objects.pack'), changed);
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ ...m, gitObjects: { ...m.gitObjects, bytes: changed.length, sha256: hash(changed) } }));
  assert.throws(() => verifySource(output, commit, expected), /manifest checksum/);
}));

test('objects for a different commit cannot be relabelled', () => fixture(({ root, git, commit, output }) => {
  const m = packSource(root, output, commit);
  writeFileSync(path.join(root, 'source.txt'), 'second\n'); git('commit', '-am', 'second', '--quiet');
  const other = git('rev-parse', 'HEAD');
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ ...m, commit: other }));
  assert.throws(() => verifySource(output, other, digest(output)), /commit mismatch/);
}));

test('missing trusted checksum and abbreviated commit are rejected', () => fixture(({ root, commit, output }) => {
  packSource(root, output, commit);
  assert.throws(() => verifySource(output, commit), /trusted manifest/);
  assert.throws(() => packSource(root, output, commit.slice(0, 7)), /full commit/);
}));

test('neither a package nor an existing restore directory is overwritten', () => fixture(({ root, commit, output, restored }) => {
  packSource(root, output, commit); const expected = digest(output);
  assert.throws(() => packSource(root, output, commit), /EEXIST/);
  restoreSource(output, commit, expected, restored);
  assert.throws(() => restoreSource(output, commit, expected, restored), /EEXIST/);
  assert.equal(readFileSync(path.join(restored, 'source.txt'), 'utf8'), 'first\n');
}));

test('resolved lock is restored while original Git lock remains available', () => fixture(({ root, commit, output, restored }) => {
  const resolved = 'lockfileVersion: 9.0\n# resolved for CI\n';
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), resolved);
  packSource(root, output, commit); restoreSource(output, commit, digest(output), restored);
  assert.equal(readFileSync(path.join(restored, 'pnpm-lock.yaml'), 'utf8'), resolved);
  assert.equal(execFileSync('git', ['-C', restored, 'show', 'HEAD:pnpm-lock.yaml'], { encoding: 'utf8' }), 'lockfileVersion: 9.0\n');
  writeFileSync(path.join(output, 'resolved-pnpm-lock.yaml'), 'changed');
  assert.throws(() => verifySource(output, commit, digest(output)), /lock checksum/);
}));

test('large source files survive Git-native restoration', () => fixture(({ root, git, output, restored }) => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 65); writeFileSync(path.join(root, 'large.txt'), bytes);
  git('add', 'large.txt'); git('commit', '--quiet', '-m', 'large source'); const commit = git('rev-parse', 'HEAD');
  packSource(root, output, commit); restoreSource(output, commit, digest(output), restored);
  assert.ok(readFileSync(path.join(restored, 'large.txt')).equals(bytes));
}));

test('extra package files are rejected', () => fixture(({ root, commit, output }) => {
  packSource(root, output, commit); const expected = digest(output); writeFileSync(path.join(output, 'extra.txt'), 'unexpected');
  assert.throws(() => verifySource(output, commit, expected), /Unexpected source artifact files/);
}));

test('artifact files cannot be replaced by symlinks', () => fixture(({ root, commit, output }) => {
  packSource(root, output, commit); const expected = digest(output);
  rmSync(path.join(output, 'resolved-pnpm-lock.yaml'));
  symlinkSync(path.join(root, 'pnpm-lock.yaml'), path.join(output, 'resolved-pnpm-lock.yaml'));
  assert.throws(() => verifySource(output, commit, expected), /regular files/);
}));

test('install or build cannot substitute the frozen dependency lock', () => fixture(({ root, commit, output }) => {
  packSource(root, output, commit); const expected = digest(output); const lock = path.join(root, 'pnpm-lock.yaml');
  assert.equal(verifySource(output, commit, expected, lock).verified, true);
  writeFileSync(lock, 'changed during build');
  assert.throws(() => verifySource(output, commit, expected, lock), /Installed dependency lock differs/);
}));

test('unrelated Git objects are rejected', () => fixture(({ root, git, commit, output }) => {
  const m = packSource(root, output, commit);
  const extra = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'SYNTHETIC_UNRELATED_OBJECT', encoding: 'utf8' }).trim();
  const ids = git('rev-list', '--objects', commit).split('\n').map((line) => line.split(' ')[0]); ids.push(extra);
  const changed = execFileSync('git', ['-C', root, 'pack-objects', '--stdout'], { input: ids.join('\n') + '\n' });
  writeFileSync(path.join(output, 'source-objects.pack'), changed);
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ ...m, gitObjects: { ...m.gitObjects, bytes: changed.length, sha256: hash(changed) } }));
  assert.throws(() => verifySource(output, commit, digest(output)), /unrelated or missing objects/);
}));

test('restoration does not follow a committed dependency-lock symlink', () => fixture(({ root, git, output, restored }) => {
  rmSync(path.join(root, 'pnpm-lock.yaml')); symlinkSync('source.txt', path.join(root, 'pnpm-lock.yaml'));
  git('add', 'pnpm-lock.yaml'); git('commit', '--quiet', '-m', 'invalid lock symlink'); const commit = git('rev-parse', 'HEAD');
  packSource(root, output, commit);
  assert.throws(() => restoreSource(output, commit, digest(output), restored), /regular file/);
  assert.equal(readFileSync(path.join(restored, 'source.txt'), 'utf8'), 'first\n');
}));

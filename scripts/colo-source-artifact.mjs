import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fullCommit = (value) => {
  if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw new Error('A full commit SHA is required.');
  return value;
};
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
Object.assign(gitEnvironment, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' });
const git = (root, args, options = {}) => execFileSync('git', ['-C', root, ...args], {
  maxBuffer: 512 * 1024 * 1024, env: gitEnvironment, ...options,
});

function sourceObjectIds(repository, commit) {
  const tree = git(repository, ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim();
  const entries = git(repository, ['ls-tree', '-r', '-t', commit], { encoding: 'utf8' });
  const ids = new Set([commit, tree]);
  for (const entry of entries.trim().split('\n')) {
    const match = entry.match(/^[0-7]{6} (blob|tree) ([a-f0-9]{40})\t/);
    if (match) ids.add(match[2]);
  }
  return [...ids].sort();
}

// A minimal object pack has this commit and its complete tree, without history.
// Git checks object hashes. The trusted expected commit therefore binds the tree.
function fromObjects(objects, commit, fn) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'colo-source-objects-'));
  try {
    git(temporary, ['init', '--bare', '--quiet', '--template=']);
    git(temporary, ['index-pack', '--stdin'], { input: objects });
    let resolved;
    try { resolved = git(temporary, ['rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
    catch { throw new Error('Source object commit mismatch.'); }
    if (resolved !== commit) throw new Error('Source object commit mismatch.');
    const actual = git(temporary, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], { encoding: 'utf8' }).trim().split('\n').sort();
    if (JSON.stringify(actual) !== JSON.stringify(sourceObjectIds(temporary, commit))) {
      throw new Error('Git object pack contains unrelated or missing objects.');
    }
    return fn(temporary);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}


// Only committed Git bytes enter the archive. Build outputs and local files do not.
export function packSource(root, output, commit) {
  fullCommit(commit);
  const resolved = git(root, ['rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim();
  if (resolved !== commit) throw new Error('The requested commit is not available.');
  const prefix = `paperclip-${commit}/`;
  const tree = git(root, ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim();
  const objects = git(root, ['pack-objects', '--stdout'], { input: sourceObjectIds(root, commit).join('\n') + '\n' });
  const tar = fromObjects(objects, commit, (repository) =>
    git(repository, ['archive', '--format=tar', `--prefix=${prefix}`, commit]));
  const archive = gzipSync(tar, { level: 9 });
  const name = `paperclip-source-${commit}.tar.gz`;
  const lockfile = readFileSync(path.join(root, 'pnpm-lock.yaml'));
  const manifest = {
    schema: 'paperclip.colo-source-artifact/v1',
    commit,
    tree,
    archive: name,
    prefix,
    bytes: archive.length,
    sha256: sha256(archive),
    content: 'committed-source-only',
    prebuiltRuntime: false,
    dependencyLock: { file: 'resolved-pnpm-lock.yaml', bytes: lockfile.length, sha256: sha256(lockfile) },
    gitObjects: { file: 'source-objects.pack', bytes: objects.length, sha256: sha256(objects) },
  };
  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(output); // The entire output directory must be new, not only our files.
  // A fixed output is single-use. Do not overwrite evidence from an earlier pack.
  writeFileSync(path.join(output, name), archive, { flag: 'wx' });
  writeFileSync(path.join(output, 'resolved-pnpm-lock.yaml'), lockfile, { flag: 'wx' });
  writeFileSync(path.join(output, 'source-objects.pack'), objects, { flag: 'wx' });
  writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

// Expected manifest SHA comes from the selected successful workflow receipt.
// This verifies bytes and the Git archive identity. It does not extract or run source.
export function verifySource(directory, commit, expectedSHA256, installedLockPath) {
  fullCommit(commit);
  if (!/^[a-f0-9]{64}$/.test(expectedSHA256 ?? '')) throw new Error('A trusted manifest SHA-256 is required.');
  const manifestBytes = readFileSync(path.join(directory, 'manifest.json'));
  if (sha256(manifestBytes) !== expectedSHA256) throw new Error('Source manifest checksum mismatch.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const name = `paperclip-source-${commit}.tar.gz`;
  if (manifest.schema !== 'paperclip.colo-source-artifact/v1' || manifest.commit !== commit ||
      manifest.archive !== name || manifest.prefix !== `paperclip-${commit}/` ||
      manifest.content !== 'committed-source-only' || manifest.prebuiltRuntime !== false ||
      !/^[a-f0-9]{40}$/.test(manifest.tree ?? '') ||
      manifest.dependencyLock?.file !== 'resolved-pnpm-lock.yaml' ||
      manifest.gitObjects?.file !== 'source-objects.pack') throw new Error('Source manifest identity mismatch.');
  const expectedFiles = ['manifest.json', name, 'resolved-pnpm-lock.yaml', 'source-objects.pack'].sort();
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expectedFiles)) {
    throw new Error('Unexpected source artifact files.');
  }
  const archive = readFileSync(path.join(directory, name));
  if (archive.length !== manifest.bytes || sha256(archive) !== manifest.sha256) {
    throw new Error('Source archive checksum mismatch.');
  }
  const lockfile = readFileSync(path.join(directory, 'resolved-pnpm-lock.yaml'));
  if (lockfile.length !== manifest.dependencyLock.bytes || sha256(lockfile) !== manifest.dependencyLock.sha256) {
    throw new Error('Resolved dependency lock checksum mismatch.');
  }
  if (installedLockPath && !readFileSync(installedLockPath).equals(lockfile)) {
    throw new Error('Installed dependency lock differs from the fixed source package.');
  }
  const tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
  const objects = readFileSync(path.join(directory, 'source-objects.pack'));
  if (objects.length !== manifest.gitObjects.bytes || sha256(objects) !== manifest.gitObjects.sha256) {
    throw new Error('Git source object checksum mismatch.');
  }
  fromObjects(objects, commit, (repository) => {
    const tree = git(repository, ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim();
    if (tree !== manifest.tree) throw new Error('Git source tree mismatch.');
    const canonical = git(repository, ['archive', '--format=tar', `--prefix=${manifest.prefix}`, commit]);
    if (!tar.equals(canonical)) throw new Error('Source archive differs from the expected Git tree.');
  });
  return { commit, manifestSHA256: expectedSHA256, archiveSHA256: manifest.sha256,
    dependencyLockSHA256: manifest.dependencyLock.sha256, bytes: archive.length, verified: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory, commit, expectedSHA256, installedLockPath, ...extra] = process.argv.slice(2);
    if (!directory || extra.length || !['pack', 'verify'].includes(command) || (command === 'pack' && (expectedSHA256 || installedLockPath))) {
      throw new Error('Usage: node scripts/colo-source-artifact.mjs pack OUTPUT COMMIT | verify DIRECTORY COMMIT MANIFEST_SHA256 [INSTALLED_LOCK_PATH]');
    }
    const result = command === 'pack' ? packSource(process.cwd(), path.resolve(directory), commit)
      : verifySource(path.resolve(directory), commit, expectedSHA256, installedLockPath);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

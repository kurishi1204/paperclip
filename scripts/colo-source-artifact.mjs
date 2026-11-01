import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fullCommit = (value) => {
  if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw new Error('A full commit SHA is required.');
  return value;
};
const git = (root, args, options = {}) => execFileSync('git', ['-C', root, ...args], {
  maxBuffer: 512 * 1024 * 1024, ...options,
});

// Only committed Git bytes enter the archive. Build outputs and local files do not.
export function packSource(root, output, commit) {
  fullCommit(commit);
  const resolved = git(root, ['rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim();
  if (resolved !== commit) throw new Error('The requested commit is not available.');
  const prefix = `paperclip-${commit}/`;
  const tar = git(root, ['archive', '--format=tar', `--prefix=${prefix}`, commit]);
  const archive = gzipSync(tar, { level: 9 });
  const name = `paperclip-source-${commit}.tar.gz`;
  const lockfile = readFileSync(path.join(root, 'pnpm-lock.yaml'));
  const manifest = {
    schema: 'paperclip.colo-source-artifact/v1',
    commit,
    tree: git(root, ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim(),
    archive: name,
    prefix,
    bytes: archive.length,
    sha256: sha256(archive),
    content: 'committed-source-only',
    prebuiltRuntime: false,
    dependencyLock: { file: 'resolved-pnpm-lock.yaml', bytes: lockfile.length, sha256: sha256(lockfile) },
  };
  mkdirSync(output, { recursive: true });
  // A fixed output is single-use. Do not overwrite evidence from an earlier pack.
  writeFileSync(path.join(output, name), archive, { flag: 'wx' });
  writeFileSync(path.join(output, 'resolved-pnpm-lock.yaml'), lockfile, { flag: 'wx' });
  writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

// Expected manifest SHA comes from the selected successful workflow receipt.
// This verifies bytes and the Git archive identity. It does not extract or run source.
export function verifySource(directory, commit, expectedSHA256) {
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
      manifest.dependencyLock?.file !== 'resolved-pnpm-lock.yaml') throw new Error('Source manifest identity mismatch.');
  const archive = readFileSync(path.join(directory, name));
  if (archive.length !== manifest.bytes || sha256(archive) !== manifest.sha256) {
    throw new Error('Source archive checksum mismatch.');
  }
  const lockfile = readFileSync(path.join(directory, 'resolved-pnpm-lock.yaml'));
  if (lockfile.length !== manifest.dependencyLock.bytes || sha256(lockfile) !== manifest.dependencyLock.sha256) {
    throw new Error('Resolved dependency lock checksum mismatch.');
  }
  const tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
  const embeddedCommit = execFileSync('git', ['get-tar-commit-id'], { input: tar.subarray(0, 1024), encoding: 'utf8' }).trim();
  if (embeddedCommit !== commit) throw new Error('Git archive commit mismatch.');
  return { commit, manifestSHA256: expectedSHA256, archiveSHA256: manifest.sha256,
    dependencyLockSHA256: manifest.dependencyLock.sha256, bytes: archive.length, verified: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory, commit, expectedSHA256, ...extra] = process.argv.slice(2);
    if (!directory || extra.length || !['pack', 'verify'].includes(command) || (command === 'pack' && expectedSHA256)) {
      throw new Error('Usage: node scripts/colo-source-artifact.mjs pack OUTPUT COMMIT | verify DIRECTORY COMMIT MANIFEST_SHA256');
    }
    const result = command === 'pack' ? packSource(process.cwd(), path.resolve(directory), commit)
      : verifySource(path.resolve(directory), commit, expectedSHA256);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Read target versions from the release package inventory, never from the owner.
export function readWorkspaceVersions(sourceRoot = repoRoot) {
  const entries = JSON.parse(readFileSync(resolve(sourceRoot, "scripts/release-package-manifest.json"), "utf8"));
  const versions = {};
  for (const { dir, name } of entries) {
    const target = JSON.parse(readFileSync(resolve(sourceRoot, dir, "package.json"), "utf8"));
    if (target.name !== name || Object.hasOwn(versions, name)) {
      throw new Error(`Workspace package identity mismatch or duplicate: ${name}`);
    }
    versions[name] = target.version;
  }
  return versions;
}

// Canonical SemVer 2.0.0 grammar: numeric identifiers have no leading zeroes,
// prerelease identifiers are nonempty, and build identifiers may contain zeroes.
// Require the entire original string, not a coerced/v-prefixed version.
function isExactPackageVersion(version) {
  if (typeof version !== "string" || version.length > 256) return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/.exec(version);
  return match !== null && match[0] === version &&
    match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part)));
}

function publishRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") ||
      value.startsWith("/") || /^[A-Za-z]:/.test(value) || /[*?\[\]{}!]/.test(value)) {
    throw new Error(`Expected a literal relative publish path: ${value}`);
  }
  const parts = value.replace(/^\.\//, "").split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === "node_modules")) {
    throw new Error(`Unsafe publish path: ${value}`);
  }
  return parts.join("/");
}

function sourcePublishExecutableFiles(pkg, sourceDir, explicit) {
  const root = realpathSync(sourceDir);
  const executable = new Set();
  function inspect(relative) {
    // Check every component: a nested declared path must not bypass a symlink.
    let current = root;
    for (const part of relative.split("/")) {
      current = resolve(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Publish source symlink is not allowed: ${relative}`);
    }
    return lstatSync(current);
  }
  function walk(relative) {
    publishRelativePath(relative);
    const info = inspect(relative);
    if (info.isDirectory()) {
      for (const name of readdirSync(resolve(root, relative)).sort()) walk(`${relative}/${name}`);
    } else if (info.isFile()) {
      if (info.mode & 0o111) executable.add(relative);
    } else throw new Error(`Publish source is not a regular file or directory: ${relative}`);
  }
  if (!Array.isArray(pkg.files)) throw new Error(`${pkg.name} must declare files for executable metadata`);
  for (const entry of pkg.files) walk(publishRelativePath(entry));
  for (const entry of explicit) {
    if (!inspect(entry).isFile()) throw new Error(`Explicit executable is not a regular source file: ${entry}`);
  }
  return executable;
}

export function materializePublishManifest(pkg, { workspaceVersions = {}, sourceDir } = {}) {
  const publishConfig = pkg.publishConfig ?? {};
  const publishManifest = { ...pkg };

  for (const key of ["main", "types", "exports", "bin"]) {
    if (publishConfig[key] !== undefined) publishManifest[key] = publishConfig[key];
  }

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!publishManifest[section]) continue;
    publishManifest[section] = Object.fromEntries(
      Object.entries(publishManifest[section]).map(([name, specifier]) => {
        if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) return [name, specifier];
        const range = specifier.slice("workspace:".length);
        if (!["*", "^", "~"].includes(range)) {
          throw new Error(`Unsupported workspace specifier for ${pkg.name} -> ${name}: ${specifier}`);
        }
        const version = Object.hasOwn(workspaceVersions, name) ? workspaceVersions[name] : undefined;
        if (!isExactPackageVersion(version)) {
          throw new Error(`Missing or invalid workspace target version for ${pkg.name} -> ${name}`);
        }
        const prefix = range === "*" ? "" : range;
        return [name, `${prefix}${version}`];
      }),
    );
  }

  const configuredExecutableFiles = publishConfig.executableFiles ?? [];
  if (!Array.isArray(configuredExecutableFiles)) throw new Error("publishConfig.executableFiles must be an array");
  const executableFiles = new Set(configuredExecutableFiles.map(publishRelativePath));
  if (sourceDir !== undefined) {
    for (const entry of sourcePublishExecutableFiles(pkg, sourceDir, executableFiles)) executableFiles.add(entry);
  }
  delete publishManifest.publishConfig;
  if (executableFiles.size) publishManifest.publishConfig = { executableFiles: [...executableFiles].sort() };
  return publishManifest;
}

export function createBundledInstallManifest(publishManifest, bundledDependencies) {
  const bundledDependencyNames = new Set(bundledDependencies);
  const installManifest = structuredClone(publishManifest);

  delete installManifest.devDependencies;

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!installManifest[section]) continue;
    installManifest[section] = Object.fromEntries(
      Object.entries(installManifest[section]).filter(([name]) => bundledDependencyNames.has(name)),
    );
    if (Object.keys(installManifest[section]).length === 0) delete installManifest[section];
  }

  return installManifest;
}

function patchedDependencyPackageName(specifier) {
  const versionSeparator = specifier.lastIndexOf("@");
  const packageNameEnd = specifier.startsWith("@") ? specifier.indexOf("/") : 0;
  if (packageNameEnd < 0) return specifier;
  return versionSeparator > packageNameEnd ? specifier.slice(0, versionSeparator) : specifier;
}

export function selectBundledDependencyPatches(
  destinationDir,
  bundledDependencies,
  patchedDependencies,
) {
  const patchesByPackageName = new Map();
  for (const [specifier, patchPath] of Object.entries(patchedDependencies)) {
    const packageName = patchedDependencyPackageName(specifier);
    const packagePatches = patchesByPackageName.get(packageName) ?? new Map();
    packagePatches.set(specifier, patchPath);
    patchesByPackageName.set(packageName, packagePatches);
  }

  const selectedPatches = [];
  for (const packageName of new Set(bundledDependencies)) {
    const packagePatches = patchesByPackageName.get(packageName);
    if (!packagePatches) continue;

    const installedManifestPath = resolve(
      destinationDir,
      "node_modules",
      packageName,
      "package.json",
    );
    let installedManifest;
    try {
      installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
    } catch (cause) {
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: failed to read ${installedManifestPath}`,
        { cause },
      );
    }

    if (
      installedManifest.name !== packageName ||
      typeof installedManifest.version !== "string" ||
      installedManifest.version.length === 0
    ) {
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: installed package manifest must declare the expected name and a version`,
      );
    }

    const installedSpecifier = `${packageName}@${installedManifest.version}`;
    const patchPath = packagePatches.get(installedSpecifier);
    if (patchPath === undefined) {
      const configuredSpecifiers = [...packagePatches.keys()].sort().join(", ");
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: installed ${installedSpecifier}, but configured patches are ${configuredSpecifiers}`,
      );
    }
    if (typeof patchPath !== "string" || patchPath.length === 0) {
      throw new Error(`Patch path for ${installedSpecifier} must be a non-empty string`);
    }
    selectedPatches.push({ packageName, specifier: installedSpecifier, patchPath });
  }

  return selectedPatches;
}

export function applyBundledDependencyPatches(destinationDir, bundledDependencies, sourceRoot = repoRoot) {
  const rootPackage = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
  const patchedDependencies = rootPackage.pnpm?.patchedDependencies ?? {};

  for (const { packageName, patchPath } of selectBundledDependencyPatches(
    destinationDir,
    bundledDependencies,
    patchedDependencies,
  )) {
    execFileSync(
      "patch",
      ["-p1", "--forward", "-d", resolve(destinationDir, "node_modules", packageName)],
      {
        input: readFileSync(resolve(sourceRoot, patchPath)),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
  }
}

// pnpm pack normalizes non-bin files, including bundled native executables.
// This is a separate boundary from source-owned files: only esbuild's declared,
// installed, version- and hash-bound binaries may receive pack metadata here.
export function preserveBundledEsbuildExecutables(destinationDir) {
  const root = realpathSync(destinationDir);
  function installedFile(relative) {
    let current = root;
    for (const part of relative.split("/")) {
      current = resolve(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Bundled esbuild symlink is not allowed: ${relative}`);
    }
    const info = lstatSync(current);
    if (!info.isFile()) throw new Error(`Bundled esbuild file is not regular: ${relative}`);
    return { path: current, info };
  }
  const esbuildDirectory = resolve(root, "node_modules/esbuild");
  if (!lstatSync(esbuildDirectory, { throwIfNoEntry: false })) return [];
  const esbuild = JSON.parse(readFileSync(installedFile("node_modules/esbuild/package.json").path, "utf8"));
  const hashes = esbuild["esbuild.binaryHashes"];
  if (esbuild.name !== "esbuild" || !isExactPackageVersion(esbuild.version) || !hashes || typeof hashes !== "object" || Array.isArray(hashes)) {
    throw new Error("Bundled esbuild requires exact version and original binary hashes");
  }
  const executableFiles = [];
  for (const [name, version] of Object.entries(esbuild.optionalDependencies ?? {})) {
    if (!/^@esbuild\/[a-z0-9-]+$/.test(name) || version !== esbuild.version) throw new Error(`Unsupported esbuild platform dependency: ${name}`);
    const relative = `node_modules/${name}`;
    if (!lstatSync(resolve(root, relative), { throwIfNoEntry: false })) continue; // Other platforms are optional.
    const platform = JSON.parse(readFileSync(installedFile(`${relative}/package.json`).path, "utf8"));
    if (platform.name !== name || platform.version !== version) throw new Error(`Bundled esbuild platform identity mismatch: ${name}`);
    const keys = Object.keys(hashes).filter((key) => key.startsWith(`${name}/`));
    if (!keys.length) throw new Error(`Missing declared esbuild binary hash: ${name}`);
    for (const key of keys) {
      publishRelativePath(key); // Reject traversal, nested node_modules and unknown path syntax.
      const entry = `node_modules/${key}`;
      const binary = installedFile(entry);
      const hash = hashes[key];
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || createHash("sha256").update(readFileSync(binary.path)).digest("hex") !== hash) {
        throw new Error(`Bundled esbuild binary hash mismatch: ${key}`);
      }
      if (!(binary.info.mode & 0o111)) throw new Error(`Bundled esbuild binary is not executable before pack: ${key}`);
      executableFiles.push(entry);
    }
  }
  if (!executableFiles.length) throw new Error("No installed executable esbuild platform binary to preserve");
  const manifestPath = installedFile("package.json").path;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!(manifest.bundleDependencies ?? manifest.bundledDependencies ?? []).length) throw new Error("Esbuild executable metadata requires a bundled package");
  const existing = manifest.publishConfig?.executableFiles ?? [];
  if (!Array.isArray(existing)) throw new Error("publishConfig.executableFiles must be an array");
  manifest.publishConfig = { ...manifest.publishConfig, executableFiles: [...new Set([...existing, ...executableFiles])].sort() };
  // No chmod, binary mutation, lifecycle execution or dependency repair.
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return executableFiles;
}

export function prepareBundledPackage(sourceDir, destinationDir, {
  sourceRoot = repoRoot,
  workspaceVersions = readWorkspaceVersions(sourceRoot),
  offlineLockfile,
  storeDir,
} = {}) {
  // Opt-in local distribution mode: never fall back to online npm on failure.
  // Read the external lock before creating the destination; pnpm checks that
  // its importer matches the restricted bundled install manifest below.
  let offlineLock;
  if (offlineLockfile !== undefined || storeDir !== undefined) {
    if (typeof offlineLockfile !== "string" || !offlineLockfile || typeof storeDir !== "string" || !storeDir) {
      throw new Error("Offline bundling requires both offlineLockfile and storeDir");
    }
    const rootPackage = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
    if (rootPackage.packageManager !== "pnpm@9.15.4") throw new Error("Offline bundling requires source packageManager pnpm@9.15.4");
    if (existsSync(destinationDir)) throw new Error("Offline bundle destination must not already exist");
    if (!lstatSync(offlineLockfile).isFile() || !lstatSync(storeDir).isDirectory()) throw new Error("Offline lock/store must be an existing regular file/directory");
    offlineLock = readFileSync(offlineLockfile);
    const version = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
    if (version !== "9.15.4") throw new Error(`Expected pnpm 9.15.4, received ${version}`);
  }
  const sourcePackagePath = resolve(sourceDir, "package.json");
  const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, "utf8"));
  const bundledDependencies = sourcePackage.bundleDependencies ?? sourcePackage.bundledDependencies ?? [];

  if (bundledDependencies.length === 0) {
    throw new Error(`${sourcePackage.name} does not declare bundled dependencies`);
  }

  const publishManifest = materializePublishManifest(sourcePackage, { workspaceVersions, sourceDir });

  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of sourcePackage.files ?? []) {
    cpSync(resolve(sourceDir, entry), resolve(destinationDir, entry), { recursive: true });
  }
  for (const entry of ["README.md", "LICENSE", "LICENSE.md"]) {
    const sourcePath = resolve(sourceDir, entry);
    if (existsSync(sourcePath)) cpSync(sourcePath, resolve(destinationDir, entry));
  }

  const deployedPackagePath = resolve(destinationDir, "package.json");
  const installManifest = createBundledInstallManifest(publishManifest, bundledDependencies);
  writeFileSync(deployedPackagePath, `${JSON.stringify(installManifest, null, 2)}\n`);

  if (offlineLock !== undefined) {
    const lockPath = resolve(destinationDir, "pnpm-lock.yaml");
    writeFileSync(lockPath, offlineLock);
    execFileSync("pnpm", [
      "install", "--ignore-workspace", "--offline", "--frozen-lockfile",
      "--ignore-scripts", "--ignore-pnpmfile", "--prod",
      "--config.node-linker=hoisted", "--config.auto-install-peers=false",
      "--store-dir", resolve(storeDir),
    ], { cwd: destinationDir, stdio: "inherit" });
    if (!readFileSync(lockPath).equals(offlineLock)) throw new Error("Frozen bundle lock changed during install");
  } else {
    execFileSync(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: destinationDir, stdio: "inherit" },
    );
  }
  writeFileSync(deployedPackagePath, `${JSON.stringify(publishManifest, null, 2)}\n`);
  applyBundledDependencyPatches(destinationDir, bundledDependencies, sourceRoot);

  if (bundledDependencies.includes("acpx")) {
    const acpxPackage = JSON.parse(
      readFileSync(resolve(destinationDir, "node_modules/acpx/package.json"), "utf8"),
    );
    const expectedPatchMarker = {
      "0.12.0": "onAgentStderr",
      "0.13.1": "spawnEnvironment",
    }[acpxPackage.version];
    const acpxRuntime = readFileSync(
      resolve(destinationDir, "node_modules/acpx/dist/runtime.js"),
      "utf8",
    );
    if (!expectedPatchMarker || !acpxRuntime.includes(expectedPatchMarker)) {
      throw new Error(
        `staged acpx@${acpxPackage.version} runtime is missing the repository patch`,
      );
    }
  }

  if (bundledDependencies.includes("embedded-postgres")) {
    const embeddedPostgresSource = readFileSync(
      resolve(destinationDir, "node_modules/embedded-postgres/dist/index.js"),
      "utf8",
    );
    if (
      !embeddedPostgresSource.includes("const LC_MESSAGES_LOCALE = 'C';") ||
      !embeddedPostgresSource.includes("globalThis.process.env")
    ) {
      throw new Error("staged embedded-postgres runtime is missing the repository patch");
    }

    const embeddedPostgresPackage = JSON.parse(
      readFileSync(resolve(destinationDir, "node_modules/embedded-postgres/package.json"), "utf8"),
    );
    const stagedPackage = JSON.parse(readFileSync(deployedPackagePath, "utf8"));
    stagedPackage.optionalDependencies = {
      ...(stagedPackage.optionalDependencies ?? {}),
      ...(embeddedPostgresPackage.optionalDependencies ?? {}),
    };
    writeFileSync(deployedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`);
    rmSync(resolve(destinationDir, "node_modules/@embedded-postgres"), { recursive: true, force: true });
  }
  preserveBundledEsbuildExecutables(destinationDir);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceDir, destinationDir, ...flags] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    const key = { "--offline-lockfile": "offlineLockfile", "--store-dir": "storeDir" }[flags[i]];
    if (!key || !flags[i + 1] || flags[i + 1].startsWith("--") || Object.hasOwn(options, key)) {
      throw new Error(`Unknown, duplicate or incomplete bundle option: ${flags[i]}`);
    }
    options[key] = resolve(flags[i + 1]);
  }
  if (!sourceDir || !destinationDir) {
    console.error("Usage: prepare-bundled-package.mjs <source-dir> <destination-dir> [--offline-lockfile <lockfile> --store-dir <store>]");
    process.exit(1);
  }
  prepareBundledPackage(resolve(sourceDir), resolve(destinationDir), options);
}

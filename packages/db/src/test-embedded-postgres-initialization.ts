import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

export type InitializationContext = {
  signal: AbortSignal;
  record: (phase: string, extra?: unknown) => void;
  assertDataDirectory?: () => void;
};

// Direct-handle evidence only. This neither inventories nor removes IPC and
// proves nothing about initdb's descendants. Any failure retains the datadir.
export async function observeInitializationChild(
  launch: () => ChildProcess,
  context: InitializationContext,
  prepared: Record<string, unknown>,
  onLog: (message: string) => void,
  cancellationTimeoutMs = 10_000,
): Promise<void> {
  const generation = randomUUID();
  const record = (phase: string, extra: Record<string, unknown> = {}) =>
    context.record(phase, { generation, ...extra });
  record("initialise_spawn_intent", prepared);
  if (context.signal.aborted) {
    record("initialise_cancelled", { beforeSpawn: true });
    throw new Error("Initialization interrupted before spawn; no start");
  }
  let child: ChildProcess;
  try { child = launch(); }
  catch (error) {
    record("initialise_spawn_failed", { errorCode: (error as NodeJS.ErrnoException).code ?? null });
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    const failures: unknown[] = [];
    let spawned = false, exited = false, settled = false, cancelled = false;
    let pid: number | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve();
    };
    const bound = () => {
      timer ??= setTimeout(() => settle(new AggregateError(failures,
        "Initialization close unproven; retain datadir and receipt; no retry")), cancellationTimeoutMs);
    };
    const stopHandle = () => {
      bound();
      // Never look up or signal a PID; only this still-live ChildProcess handle.
      if (spawned && !exited && child.exitCode === null && child.signalCode === null) {
        try { if (!child.kill("SIGTERM")) failures.push(new Error("Initialization signal not delivered")); }
        catch (error) { failures.push(error); }
      }
    };
    const save = (phase: string, extra: Record<string, unknown> = {}) => {
      try { record(phase, { pid, ...extra }); }
      catch (error) { failures.push(error); stopHandle(); }
    };
    const cancel = () => {
      if (cancelled || settled) return;
      cancelled = true;
      failures.push(new Error("Initialization interrupted; no start"));
      save("initialise_cancelled", { beforeSpawn: !spawned });
      stopHandle();
    };
    child.once("spawn", () => {
      spawned = true; pid = child.pid;
      if (!Number.isSafeInteger(pid) || pid! <= 1) failures.push(new Error("Initialization child identity unavailable"));
      save("initialise_spawned", { spawnfile: child.spawnfile });
      if (cancelled || failures.length) stopHandle();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      failures.push(error);
      save("initialise_child_error", { errorCode: error.code ?? null });
      stopHandle();
    });
    child.once("exit", (code, signal) => {
      exited = true; exit = { code, signal };
      save("initialise_child_exit", { code, signal });
    });
    child.once("close", (code, signal) => {
      save("initialise_child_close", { code, signal, exitObserved: exited });
      if (!spawned || !exited || !exit || exit.code !== code || exit.signal !== signal || code !== 0 || signal !== null) {
        failures.push(new Error(`Initialization child did not exit and close normally (code=${code}, signal=${signal})`));
      }
      if (context.signal.aborted && !cancelled) cancel();
      settle(failures.length ? new AggregateError(failures, "Initialization failed or evidence write failed; no start/retry/cleanup") : undefined);
    });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => {
      try { onLog(String(chunk)); } catch (error) { failures.push(error); stopHandle(); }
    });
    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) cancel();
  });
}

// The test entry owns initdb instead of calling embedded-postgres.initialise(),
// whose local spawn handle is inaccessible. Keep its native binary resolver,
// root permission checks, arguments and locale; never create a system user.
export async function initialiseTestCluster(options: {
  databaseDir: string; user: string; password: string; authMethod: string;
  initdbFlags: string[]; onLog: (message: string) => void;
  permissionIds: () => Promise<{ uid?: number; gid?: number }>;
}, context: InitializationContext): Promise<void> {
  const check = () => {
    if (context.signal.aborted) throw new Error("Initialization interrupted during preparation; no spawn/start");
    context.assertDataDirectory?.();
  };
  check();
  const binaries = await testPostgresBinaries();
  check();
  const ids = await options.permissionIds();
  check();
  for (const value of [ids.uid, ids.gid]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid initdb permission identity");
  for (const binary of [binaries.initdb, binaries.postgres]) {
    const st = fs.statSync(binary);
    if ((st.mode & 0o555) !== 0o555) fs.chmodSync(binary, st.mode | 0o555);
  }
  const executable = fs.statSync(binaries.initdb);
  const passwordFile = `${options.databaseDir}.initdb-password-${randomUUID()}`;
  // Separate from the empty cluster directory; never record password or argv.
  const fd = fs.openSync(passwordFile, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, options.password + "\n");
      if (ids.uid !== undefined) fs.fchownSync(fd, ids.uid, ids.gid ?? -1);
    } finally { fs.closeSync(fd); }
    check();
    await observeInitializationChild(() => spawn(binaries.initdb, [
      `--pgdata=${options.databaseDir}`, `--auth=${options.authMethod}`,
      `--username=${options.user}`, `--pwfile=${passwordFile}`,
      "--lc-messages=C", ...options.initdbFlags,
    ], { ...ids, env: { ...process.env, LC_MESSAGES: "C" } }), context,
    { executable: binaries.initdb, executableDevice: executable.dev, executableInode: executable.ino,
      dependencyVersion: "18.1.0-beta.16", scope: "direct_initdb_child_only" }, options.onLog);
  } finally { fs.unlinkSync(passwordFile); }
  check();
}

// Version-bound resolver shared by initdb and the cancellable postmaster start.
export async function testPostgresBinaries(): Promise<{initdb:string;postgres:string}> {
  const entry = createRequire(import.meta.url).resolve("embedded-postgres");
  const version = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(entry)), "package.json"), "utf8")).version;
  if(version!=="18.1.0-beta.16")throw new Error("Unreviewed embedded-postgres initialization contract; no spawn");
  const resolver = await import(pathToFileURL(path.join(path.dirname(entry), "binary.js")).href);
  return resolver.default();
}

// The library start() has an await before spawn but no cancellation hook. Keep
// that same readiness contract, with cancellation immediately before adoption.
export async function observePostmasterStartup(
  prepare: () => Promise<() => ChildProcess>, context: InitializationContext,
  adopt: (child:ChildProcess)=>void, onLog:(message:string)=>void,
): Promise<void> {
  const check = () => {
    if(context.signal.aborted)throw new Error("Postmaster start interrupted; no spawn/start");
    context.assertDataDirectory?.();
  };
  check();
  const launch = await prepare();
  check();
  const child = launch();
  adopt(child);
  await new Promise<void>((resolve,reject)=>{
    let settled=false;
    const settle=(error?:unknown)=>{
      if(settled)return;settled=true;context.signal.removeEventListener("abort",abort);
      if(error)reject(error);else resolve();
    };
    const abort=()=>settle(new Error("Postmaster startup interrupted; owned handle requires stop"));
    child.on("error",error=>settle(error));
    child.once("close",()=>settle(new Error("Postmaster exited before ready")));
    child.stderr?.on("data",chunk=>{
      const message=String(chunk);
      try{onLog(message);}catch(error){settle(error);return;}
      if(message.includes("database system is ready to accept connections"))settle();
    });
    context.signal.addEventListener("abort",abort,{once:true});
    if(context.signal.aborted)abort();
  });
}

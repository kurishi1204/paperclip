import fs from "node:fs";
import { initialiseTestCluster, observePostmasterStartup, testPostgresBinaries, type InitializationContext } from "./test-embedded-postgres-initialization.js";
import { beginTestIpc, cleanupSavedTestDatadirs } from "./test-embedded-postgres-ipc.js";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { applyPendingMigrations, closeRegisteredClients, ensurePostgresDatabase } from "./client.js";
import {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";

// Time budget (ms) for a vitest test in the embedded-Postgres cost class: a
// test that starts an embedded Postgres cluster and runs migrations. Measured
// evidence: this cost class normally finishes in well under 10s. Under a
// contended CI runner the same test took up to 4.9x longer. This budget
// gives about 10x headroom over the clean time, so a contended run still
// passes while a genuine hang still fails fast.
export const EMBEDDED_POSTGRES_TEST_TIMEOUT_MS = 90_000;

type EmbeddedPostgresInstance = {
  process?: ChildProcess;
  initialise(): Promise<void>;
  initialiseObserved?(context: InitializationContext): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  postgresFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

let embeddedPostgresSupportPromise: Promise<EmbeddedPostgresTestSupport> | null = null;

const DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT = 54329;

function getReservedTestPorts(): Set<number> {
  const configuredPorts = [
    DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT,
    Number.parseInt(process.env.PAPERCLIP_EMBEDDED_POSTGRES_PORT ?? "", 10),
    ...String(process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS ?? "")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10)),
  ];
  return new Set(configuredPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535));
}

type EmbeddedPostgresCtorProvider = () => Promise<EmbeddedPostgresCtor>;

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  await prepareEmbeddedPostgresNativeRuntime();
  // Version-bound runtime seam: this shipped implementation exposes its ChildProcess
  // as a JavaScript property although the declaration marks it private.
  class ObservedEmbeddedPostgres extends mod.default {
    private initializationController?: AbortController;
    private initializationPromise?: Promise<void>;
    private startupPromise?: Promise<void>;
    private stopPromise?: Promise<void>;
    private context?: InitializationContext;
    async start(): Promise<void> {
      if (!this.context || this.startupPromise) throw new Error("Missing initialization or repeated start");
      const processOwner = this as unknown as {process?:ChildProcess;getUidAndGid():Promise<{uid?:number;gid?:number}>};
      this.startupPromise = observePostmasterStartup(async () => {
        const { postgres } = await testPostgresBinaries();
        const ids = await processOwner.getUidAndGid();
        // Final cancellation/datadir check is inside observePostmasterStartup,
        // immediately before this synchronous launch+adoption (no await gap).
        return () => spawn(postgres, ["-D",this.options.databaseDir,"-p",String(this.options.port),...this.options.postgresFlags],
          {...ids,env:{...process.env,LC_MESSAGES:"C"}});
      }, this.context, child => {processOwner.process=child;}, this.options.onLog);
      await this.startupPromise;
    }
    async stop(): Promise<void> {
      return this.stopPromise ??= (async () => {
        // The dependency exit hook and explicit cleanup converge here too.
        this.initializationController?.abort();
        await this.initializationPromise?.catch(() => {});
        await this.startupPromise?.catch(() => {});
        const owner = this as unknown as {process?:ChildProcess};
        if(owner.process && (owner.process.exitCode!==null || owner.process.signalCode!==null)) owner.process=undefined;
        await super.stop();
      })();
    }
    async initialiseObserved(context: InitializationContext): Promise<void> {
      if (this.initializationPromise) throw new Error("Initialization already attempted; no replay");
      this.initializationController = new AbortController();
      // Version-bound private methods in 18.1.0-beta.16, inspected alongside
      // binary.js. They retain the original root-user contract, without the
      // inaccessible initialise() spawn or any user-creation option.
      const permissionMethods = this as unknown as {
        checkForRootUser(): Promise<void>;
        getUidAndGid(): Promise<{uid?:number;gid?:number}>;
      };
      this.context = { ...context, signal: AbortSignal.any([context.signal, this.initializationController.signal]) };
      this.initializationPromise = initialiseTestCluster({ ...this.options, permissionIds: async () => {
        await permissionMethods.checkForRootUser();
        return permissionMethods.getUidAndGid();
      } }, this.context);
      await this.initializationPromise;
    }
  }
  return ObservedEmbeddedPostgres as unknown as EmbeddedPostgresCtor;
}

let embeddedPostgresCtorProvider: EmbeddedPostgresCtorProvider = loadEmbeddedPostgresCtor;

// Test seam. Replace the embedded-postgres constructor provider so a test can
// simulate a failed start without the native runtime. Pass `null` to restore
// the default provider. This module is test support only, so the seam is safe.
export function __setEmbeddedPostgresCtorProviderForTests(
  provider: EmbeddedPostgresCtorProvider | null,
): void {
  embeddedPostgresCtorProvider = provider ?? loadEmbeddedPostgresCtor;
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  return await embeddedPostgresCtorProvider();
}

async function getAvailablePort(): Promise<number> {
  const reservedPorts = getReservedTestPorts();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("Failed to allocate test port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });

    if (!reservedPorts.has(port)) return port;
  }

  throw new Error(
    `Failed to allocate embedded Postgres test port outside reserved Paperclip ports: ${[
      ...reservedPorts,
    ].join(", ")}`,
  );
}

async function createEmbeddedPostgresTestInstance(tempDirPrefix: string) {
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  assertNotInterrupted();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix));
  const port = await getAvailablePort();
  assertNotInterrupted();

  // Postgres writes the true reason for a failed start to its output, for
  // example `could not bind IPv4 address "127.0.0.1": Address already in use`.
  // The `start()` rejection carries an empty message, so we capture the output
  // in a bounded buffer and surface it in the thrown error.
  const logBuffer = createEmbeddedPostgresLogBuffer();
  const originalDirectory = fs.lstatSync(dataDir);
  const assertDataDirectory = () => {
    const current = fs.lstatSync(dataDir);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== originalDirectory.dev ||
        current.ino !== originalDirectory.ino || current.uid !== originalDirectory.uid)
      throw new Error("Initialization datadir generation changed; no start/cleanup");
  };
  const ipc = await beginTestIpc(dataDir);
  let instance:EmbeddedPostgresInstance;
  try {
    assertNotInterrupted();
    assertDataDirectory();
    instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    postgresFlags: ["-h", "127.0.0.1", "-k", ""],
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: (message) => logBuffer.append(message),
    onError: (message) => logBuffer.append(message),
  }); } catch(error) {
    const failures:unknown[]=[error];
    try { ipc.record("constructor_failed",{error:String(error)}); } catch(recordError) { failures.push(recordError); }
    try { await ipc.finish(); } catch(cleanupError) { failures.push(cleanupError); }
    throw new AggregateError(failures,`Embedded Postgres constructor failed: ${String(error)}`);
  }

  instanceEvidence.set(instance,{dataDir,ipc,assertDataDirectory});
  activeInstances.add(instance);
  return { dataDir, port, instance, getRecentLogs: () => logBuffer.getRecentLogs() };
}

function cleanupEmbeddedPostgresTestDir(dataDir: string) {
  fs.rmSync(dataDir, {recursive:true,force:false});
}

const instanceEvidence = new WeakMap<EmbeddedPostgresInstance, {
  dataDir:string; ipc:Awaited<ReturnType<typeof beginTestIpc>>; assertDataDirectory:()=>void;
  initialization?: Promise<void>; initializationComplete?: boolean; startAttempted?: boolean;
}>();
const activeInstances = new Set<EmbeddedPostgresInstance>();
let interruption = false;
const initializationAbort = new AbortController();
function assertNotInterrupted() {
  if (interruption) throw new Error("Test interrupted; no new database start");
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  interruption = true;
  initializationAbort.abort();
  void (async () => {
    for (const instance of activeInstances) {
      const evidence = instanceEvidence.get(instance);
      try {
        evidence?.ipc.record("interrupted", { signal, pid: instance.process?.pid,
          resume: "retain datadir; child exit does not prove descendant or IPC cleanup" });
      } catch (error) { console.error("Interrupted receipt write failed", String(error)); }
      // The same owned promise handles cancellation and durable exit/close.
      // A missing handle/receipt never becomes a positive initialization exit.
      if (evidence?.initialization) await evidence.initialization.catch(() => {});
      try { await stopEmbeddedPostgresBounded(instance); }
      catch (error) { console.error(String(error)); }
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  })();
});

const EMBEDDED_POSTGRES_STOP_TIMEOUT_MS = 60_000;
const instanceStops = new WeakMap<EmbeddedPostgresInstance, Promise<void>>();
async function stopEmbeddedPostgresBounded(instance: EmbeddedPostgresInstance | null, cleanupFn?:()=>void):Promise<void> {
  if(!instance)throw new Error("Missing instance: cleanup cannot prove process exit");
  const existing=instanceStops.get(instance);
  if(existing)return existing;
  const stopped=stopEmbeddedPostgresOnce(instance,cleanupFn);
  instanceStops.set(instance,stopped);
  return stopped;
}
async function stopEmbeddedPostgresOnce(instance: EmbeddedPostgresInstance, cleanupFn?:()=>void):Promise<void> {
  if(!instance) throw new Error("Missing instance: cleanup cannot prove process exit");
  const evidence=instanceEvidence.get(instance);
  const child=instance.process;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    if (!child && evidence?.initialization && (!evidence.initializationComplete || !evidence.startAttempted || interruption)) {
      // Release the lease through finish, but forbid its success marker even
      // when an inventory happens to be unchanged. The receipt remains a hold.
      await evidence.ipc.finish({ initializationUnproven: true });
      throw new Error("Initialization exit/close unproven; retain datadir");
    }
    evidence?.ipc.record("stop_requested",{pid:child?.pid,exitCode:child?.exitCode,signalCode:child?.signalCode});
    // The library waits forever when stop() is called after its child already exited.
    if(!child || child.exitCode!==null || child.signalCode!==null) {
      if(child) instance.process=undefined;
    } else {
      await Promise.race([instance.stop(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Postgres stop timeout; retain datadir")),EMBEDDED_POSTGRES_STOP_TIMEOUT_MS);})]);
      if(child.exitCode===null&&child.signalCode===null) throw new Error("Postgres exit unproven; retain datadir");
    }
    evidence?.ipc.record("exit_observed",{pid:child?.pid,exitCode:child?.exitCode,signalCode:child?.signalCode});
    const ipcCleanup = await evidence?.ipc.finish({initializationUnproven:Boolean(evidence?.initialization && (!evidence.initializationComplete || interruption))});
    if(!ipcCleanup || typeof ipcCleanup.dataDirCleanupAllowed!=="boolean") throw new Error("IPC cleanup result missing; retain datadir");
    if(cleanupFn && (!child || child.exitCode!==0 || child.signalCode!==null)) throw new Error("Normal test database exit unproven; retain data");
    // Only this successfully exited child plus explicit whole-inventory permission permits
    // reclaiming its synthetic disposable data. Failed/unknown starts keep data.
    if(cleanupFn && child?.exitCode===0 && child.signalCode===null && ipcCleanup.dataDirCleanupAllowed===true){
      evidence?.ipc.record("data_cleanup_intent",{syntheticOnly:true,processExitCode:child.exitCode});
      cleanupFn();
      evidence?.ipc.record("data_cleanup_complete",{dataDirAbsent:!fs.existsSync(evidence!.dataDir)});
    } else evidence?.ipc.record("data_retained",{reason:ipcCleanup?.dataDirCleanupAllowed===false?"owned IPC absent; foreign inventory changed; datadir retained":"no normal child exit or failure-investigation path"});
    activeInstances.delete(instance);
  } catch(error) {
    try { evidence?.ipc.record("stop_failed",{error:String(error),pid:child?.pid,exitCode:child?.exitCode,signalCode:child?.signalCode}); } catch(recordError) { throw new AggregateError([error,recordError],"Cleanup and failure receipt both failed; retain datadir"); }
    throw new Error(`Postgres cleanup failed; retain ${evidence?.dataDir??"unknown datadir"}: ${String(error)}`);
  } finally { if(timer) clearTimeout(timer); }
}

// Upper bound on start attempts. `getAvailablePort` uses a check-then-use probe:
// it binds port 0, reads the assigned port, closes the probe, then Postgres binds
// that port. Under load another process can take the port in that window, so the
// bind fails with "Address already in use" and `start()` rejects. Each retry uses
// a fresh port and a fresh data directory, so a transient collision clears.
const EMBEDDED_POSTGRES_START_MAX_ATTEMPTS = 5;

// Start one embedded Postgres cluster with a bounded retry. Each attempt gets a
// fresh port and a fresh data directory. Only proven port conflicts can retry;
// failed data and all receipts are retained; verified successful synthetic data is cleaned. After the last attempt
// we throw with the real Postgres output so the failure is loud and diagnosable.
async function startEmbeddedPostgresWithRetry(tempDirPrefix: string): Promise<{
  port: number;
  dataDir: string;
  instance: EmbeddedPostgresInstance;
}> {
  let lastError = new Error("embedded Postgres startup failed");

  for (let attempt = 1; attempt <= EMBEDDED_POSTGRES_START_MAX_ATTEMPTS; attempt += 1) {
    if(interruption)throw new Error("Test interrupted; no new database start");
    const created = await createEmbeddedPostgresTestInstance(tempDirPrefix);
    try {
      const evidence = instanceEvidence.get(created.instance)!;
      // Schedule after assigning the promise, so signal cleanup sees preparation
      // as well as the spawned child. Test constructors keep their mock seam.
      evidence.initialization = Promise.resolve().then(async () => {
        assertNotInterrupted();
        evidence.assertDataDirectory();
        evidence.ipc.record("initialise_started", { observedChild: Boolean(created.instance.initialiseObserved) });
        if (created.instance.initialiseObserved) {
          await created.instance.initialiseObserved({ signal: initializationAbort.signal, record: evidence.ipc.record, assertDataDirectory: evidence.assertDataDirectory });
        } else {
          await created.instance.initialise();
        }
        assertNotInterrupted();
        evidence.assertDataDirectory();
        evidence.ipc.record("initialise_exited");
        evidence.initializationComplete = true;
      });
      await evidence.initialization;
      assertNotInterrupted();
      evidence.startAttempted = true;
      await created.instance.start();
      assertNotInterrupted();
      instanceEvidence.get(created.instance)?.ipc.record("running",{pid:created.instance.process?.pid,spawnfile:created.instance.process?.spawnfile,postmasterPid:created.instance.process?fs.readFileSync(path.join(created.dataDir,"postmaster.pid"),"utf8"):null,segments:instanceEvidence.get(created.instance)?.ipc.snapshot()});
      return { port: created.port, dataDir: created.dataDir, instance: created.instance };
    } catch (error) {
      lastError = formatEmbeddedPostgresError(error, {
        fallbackMessage: "embedded Postgres startup failed",
        recentLogs: created.getRecentLogs(),
      });
      // Stop and verify residual IPC before considering another attempt; retain data.
      try { await stopEmbeddedPostgresBounded(created.instance); }
      catch (stopError) { throw new AggregateError([lastError, stopError], `${lastError.message}; ${String(stopError)}`); }
      if (interruption || !instanceEvidence.get(created.instance)?.initializationComplete) throw lastError;
      // Only a positively identified port collision permits a fresh attempt.
      if(!lastError.message.includes("Address already in use") || /shmget|shmat|No space left|Operation not permitted/.test(lastError.message)) throw lastError;
    }
  }

  throw new Error(
    `Failed to start embedded PostgreSQL test database after ${EMBEDDED_POSTGRES_START_MAX_ATTEMPTS} attempts: ${lastError.message}`,
  );
}

// Test-only accessors. Production callers use `startEmbeddedPostgresTestDatabase`
// or `getEmbeddedPostgresTestSupport`. A test drives the bounded retry directly
// so it does not need a real Postgres connection.
export const __startEmbeddedPostgresWithRetryForTests = startEmbeddedPostgresWithRetry;
export const __embeddedPostgresStartMaxAttemptsForTests = EMBEDDED_POSTGRES_START_MAX_ATTEMPTS;

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  let started: { dataDir: string; instance: EmbeddedPostgresInstance } | null = null;

  try {
    started = await startEmbeddedPostgresWithRetry("paperclip-embedded-postgres-probe-");
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error, {
        fallbackMessage: "embedded Postgres startup failed",
      }).message,
    };
  } finally {
    if (started) {
      const { dataDir, instance } = started;
      await stopEmbeddedPostgresBounded(instance, () => cleanupEmbeddedPostgresTestDir(dataDir));
    }
  }
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  if (!embeddedPostgresSupportPromise) {
    embeddedPostgresSupportPromise = probeEmbeddedPostgresSupport();
  }
  return await embeddedPostgresSupportPromise;
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  // The bounded retry hardens the cluster start against the port race. It throws
  // with the real Postgres output if every attempt fails.
  const { port, dataDir, instance } = await startEmbeddedPostgresWithRetry(tempDirPrefix);

  try {
    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);

    return {
      connectionString,
      cleanup: async () => {
        // End every client a caller created against this cluster first. A
        // client that still holds a reserved connection when the cluster
        // stops can crash the process: the stop kills the backend socket,
        // but a queued write on that connection still fires later and finds
        // a null socket.
        await closeRegisteredClients(connectionString);
        await stopEmbeddedPostgresBounded(instance, () => cleanupEmbeddedPostgresTestDir(dataDir));
      },
    };
  } catch (error) {
    await stopEmbeddedPostgresBounded(instance);
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${
        formatEmbeddedPostgresError(error, {
          fallbackMessage: "embedded Postgres startup failed",
        }).message
      }`,
    );
  }
}

export const cleanupCompletedEmbeddedPostgresTestDatadirs = () => cleanupSavedTestDatadirs(cleanupEmbeddedPostgresTestDir);

import net from "node:net";
import { readLocalServicePortOwner } from "../server/src/services/local-service-supervisor.ts";

// Inspect only a listener owned by this short-lived probe. Importing the
// service helper does not start Paperclip, a database, or a managed service.
const listener = net.createServer();
try {
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const owner = await readLocalServicePortOwner(address.port);
  if (owner !== process.pid) {
    throw new Error(
      `Port-owner lookup returned ${owner ?? "no owner"} for probe PID ${process.pid}. `
      + "Preserve the host PATH and its ownership tools; macOS normally needs /usr/sbin for lsof.",
    );
  }
  console.log(`[test:host] Local listener belongs to probe PID ${process.pid}.`);
} catch (error) {
  console.error(`[test:host] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (listener.listening) {
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
}

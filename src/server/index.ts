import path from "node:path";
import os from "node:os";
import { createApp } from "./app.js";
import { acquireLock } from "./security.js";

process.umask(0o077);
const dataDir = path.resolve(
  process.env["AGENTOPS_DATA_DIR"] ?? path.join(os.homedir(), ".agentops"),
);
const port = Number(process.env["AGENTOPS_PORT"] ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("AGENTOPS_PORT must be between 1024 and 65535");
const unlock = acquireLock(dataDir);
const app = createApp({ dbPath: path.join(dataDir, "agentops.sqlite"), port });
try {
  await app.listen();
  console.log(`AgentOps http://127.0.0.1:${port}\nLocal data: ${dataDir}`);
} catch (error) {
  unlock();
  throw error;
}
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } finally {
    unlock();
    process.exit(0);
  }
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

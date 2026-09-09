/**
 * Finding out whether the server is up, and starting it if it is not.
 *
 * Used by `open-layout.mjs`, so Blender's "open layout" button works whether or
 * not SketchSpace happens to be running, and by `require-server-stopped.mjs`,
 * which needs the same question answered the other way round.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import net from "node:net";
import path from "node:path";

/** Is something listening on this port? */
export const isPortListening = (port, host = "127.0.0.1") =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (listening) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(1000);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the port answers, or give up. */
export const waitForServer = async (port, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortListening(port)) {
      return true;
    }
    await sleep(400);
  }
  return false;
};

/**
 * Start the server as a detached process.
 *
 * Detached and unref'd on purpose: Blender launched us, and the server must
 * outlive both this script and Blender itself rather than dying with whatever
 * happened to start it. Output goes to a log file, because a detached process
 * with no stdio leaves nothing at all to diagnose when it fails to come up.
 */
export const startServerDetached = ({ repoRoot, envPath, logPath }) => {
  const fd = openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [`--env-file-if-exists=${envPath}`, path.join(repoRoot, "dist/server/index.js")],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    },
  );
  child.unref();
  return child.pid;
};

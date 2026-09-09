/**
 * Refuse to run while the server is up.
 *
 * The server keeps open pages in an in-memory store and writes them back on a
 * debounce. A script that edits page_scenes directly under a running server gets
 * silently overwritten the next time that page flushes - the edit appears to
 * work, then vanishes minutes later.
 *
 * Only scripts that modify EXISTING pages need this. Creating a new board is
 * safe: the server has nothing cached for a page that did not exist yet.
 */
import { isPortListening } from "./server-control.mjs";

export const requireServerStopped = async (port) => {
  if (!(await isPortListening(port))) {
    return;
  }
  console.error(
    `\n[refusing] SketchSpace is running on port ${port}.\n\n` +
      `  It caches open pages in memory and would overwrite this edit.\n` +
      `  Stop it first:\n\n` +
      `    Get-NetTCPConnection -LocalPort ${port} -State Listen |\n` +
      `      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n`,
  );
  process.exit(1);
};

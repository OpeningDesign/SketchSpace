import type { SyncElement } from "./types.js";

/**
 * Server-side mirror of Excalidraw's reconciliation rule.
 *
 * See packages/excalidraw/data/reconcile.ts in the excalidraw repo:
 * a remote element is discarded when the local one is newer, where "newer"
 * means a higher `version`, with ties broken deterministically by the LOWER
 * `versionNonce`. The client-side original also protects elements the local
 * user is actively editing; the server has no such notion, so that clause
 * is the one difference.
 *
 * Keeping these two rules in agreement is what lets the server hold
 * authoritative state without the clients ever disagreeing with it.
 */
export const shouldAcceptRemote = (
  local: SyncElement | undefined,
  remote: SyncElement,
): boolean => {
  if (!local) {
    return true;
  }
  if (remote.version > local.version) {
    return true;
  }
  if (
    remote.version === local.version &&
    remote.versionNonce < local.versionNonce
  ) {
    return true;
  }
  return false;
};

/**
 * Order elements the way Excalidraw's `orderByFractionalIndex` does: by
 * fractional index, ties broken by id.
 */
export const orderElements = (elements: SyncElement[]): SyncElement[] =>
  [...elements].sort((a, b) => {
    const ai = a.index ?? "";
    const bi = b.index ?? "";
    if (ai < bi) {
      return -1;
    }
    if (ai > bi) {
      return 1;
    }
    return a.id < b.id ? -1 : 1;
  });

/**
 * Apply an incoming batch to the authoritative element map.
 * Returns only the elements that actually won, so we rebroadcast a delta
 * rather than the whole scene.
 */
export const applyRemoteElements = (
  authoritative: Map<string, SyncElement>,
  incoming: readonly SyncElement[],
): SyncElement[] => {
  const accepted: SyncElement[] = [];

  for (const remote of incoming) {
    if (
      !remote ||
      typeof remote.id !== "string" ||
      typeof remote.version !== "number" ||
      typeof remote.versionNonce !== "number"
    ) {
      continue;
    }
    if (shouldAcceptRemote(authoritative.get(remote.id), remote)) {
      authoritative.set(remote.id, remote);
      accepted.push(remote);
    }
  }

  return accepted;
};

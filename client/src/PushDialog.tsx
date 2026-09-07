import { useEffect, useState } from "react";

import { api } from "./api";

import type { PushResult } from "./types";

/**
 * "Push to Bonsai": write drawing positions back into the layout SVG.
 *
 * This writes into the user's project repository, so it always previews first.
 * The preview is a plain list of millimetre offsets - the same thing that will
 * show up as a one-line diff per drawing in git.
 */
export const PushDialog = ({
  boardId,
  onClose,
}: {
  boardId: string;
  onClose: () => void;
}) => {
  const [preview, setPreview] = useState<PushResult | null>(null);
  const [done, setDone] = useState<PushResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .pushLayout(boardId, true)
      .then(setPreview)
      .catch((e: Error) => setError(e.message));
  }, [boardId]);

  const write = async () => {
    setBusy(true);
    setError(null);
    try {
      setDone(await api.pushLayout(boardId, false));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const result = done ?? preview;
  const offset = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__panel" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2>Push to Bonsai</h2>
          <button className="linkish" onClick={onClose}>
            ✕
          </button>
        </header>

        {error && <p className="error">{error}</p>}
        {!result && !error && <p className="muted">Checking for moved drawings…</p>}

        {result && result.total === 0 && (
          <p className="muted">
            No drawings have moved. Only imported Bonsai placements are written
            back — redlines you draw stay in SketchSpace.
          </p>
        )}

        {result && result.total > 0 && (
          <>
            {result.layouts.map((l) => (
              <div key={l.layoutPath} className="push">
                <div className="push__path" title={l.layoutPath}>
                  {l.layoutPath.split(/[\\/]/).pop()}
                </div>
                <ul className="push__list">
                  {l.moved.map((m) => (
                    <li key={m.groupKey}>
                      <span className="push__id">
                        {m.globalId ?? `${m.kind} ${m.groupKey}`}
                      </span>
                      <span className="push__delta">
                        {offset(m.dx)}, {offset(m.dy)} mm
                      </span>
                      {m.warnings.map((w) => (
                        <span key={w} className="push__warn">
                          {w}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {result.errors.map((e) => (
              <p key={e} className="error">
                {e}
              </p>
            ))}

            {done ? (
              <p className="push__ok">
                Written. Now run <code>bpy.ops.bim.create_sheets()</code> in
                Blender to rebuild the sheet.
              </p>
            ) : (
              <>
                <p className="muted">
                  This edits the layout SVG in your project repository — one line
                  per drawing, reviewable in git.
                </p>
                <div className="row row--end">
                  <button className="linkish" onClick={onClose}>
                    Cancel
                  </button>
                  <button onClick={write} disabled={busy}>
                    {busy ? "Writing…" : `Write ${result.total} change${result.total === 1 ? "" : "s"}`}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {done && (
          <div className="row row--end">
            <button onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
};

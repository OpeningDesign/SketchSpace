/**
 * Editing a sheet's view-title and titleblock values, from the sheet.
 *
 * Select a drawing's title or the titleblock and this shows what its template
 * fills in - `{{Name}}`, `{{Identification}}` - as boxes to type in. Saving sends
 * the values to the Blender that has the model open, which renames whatever has
 * to be renamed; the sheet then updates itself the way any other change in
 * Bonsai does. Nothing is written to the IFC or to the layout from here.
 *
 * Fields the model cannot take are shown all the same, with the reason Bonsai
 * gives: a scale comes from the drawing's camera, not from text. With no Blender
 * connected the values are still on the sheet - they came from the saved file -
 * so the panel says where to go rather than disappearing.
 */
import { useEffect, useRef, useState } from "react";

import { api, type BonsaiRef, type ViewFields } from "./api";

type Props = {
  excalidrawAPI: {
    onChange: (cb: (elements: readonly any[], appState: any) => void) => () => void;
    getSceneElements: () => readonly any[];
    getAppState: () => any;
  } | null;
};

type Meta = { layout?: string; groupKey?: string; kind?: string; globalId?: string | null };

/** The one Bonsai group the selection is in, or null if it is not exactly one. */
const selectedGroup = (elements: readonly any[], selected: Record<string, boolean>): BonsaiRef | null => {
  let found: BonsaiRef | null = null;
  for (const el of elements) {
    if (el.isDeleted || !selected[el.id]) {
      continue;
    }
    const meta = (el.customData as { bonsai?: Meta } | undefined)?.bonsai;
    if (!meta?.layout || !meta.groupKey) {
      return null; // a redline is in the selection: not a request to edit a view
    }
    if (found && (found.layout !== meta.layout || found.groupKey !== meta.groupKey)) {
      return null; // more than one view: there is no single thing to edit
    }
    found ??= {
      layout: meta.layout,
      groupKey: meta.groupKey,
      kind: meta.kind,
      globalId: meta.globalId ?? null,
    };
  }
  return found;
};

/**
 * The view behind a locked element the editor has made active.
 *
 * Bonsai locks the titleblock (`sodipodi:insensitive`), and a locked element is
 * never selected - clicking it only makes it active, to offer the padlock. It
 * would otherwise be the one view on the sheet that cannot be edited, and
 * locking is about not dragging it, not about its values.
 */
const activeLocked = (elements: readonly any[], activeLockedId: string | null): BonsaiRef | null => {
  if (!activeLockedId) {
    return null;
  }
  for (const el of elements) {
    if (el.isDeleted || (el.id !== activeLockedId && !(el.groupIds ?? []).includes(activeLockedId))) {
      continue;
    }
    const meta = (el.customData as { bonsai?: Meta } | undefined)?.bonsai;
    if (meta?.layout && meta.groupKey) {
      return {
        layout: meta.layout,
        groupKey: meta.groupKey,
        kind: meta.kind,
        globalId: meta.globalId ?? null,
      };
    }
  }
  return null;
};

/**
 * The view the panel is on, if it is still on the sheet - with its layout as
 * the sheet now spells it.
 *
 * Renaming a sheet renames its layout file, so every element is relinked to the
 * new path while the group itself is untouched. Following the group rather than
 * the path is what lets the panel stay open across the rename it just made.
 */
const stillThere = (elements: readonly any[], held: BonsaiRef | null): BonsaiRef | null => {
  if (!held) {
    return null;
  }
  for (const el of elements) {
    if (el.isDeleted) {
      continue;
    }
    const meta = (el.customData as { bonsai?: Meta } | undefined)?.bonsai;
    if (meta?.layout && meta.groupKey === held.groupKey) {
      return { ...held, layout: meta.layout };
    }
  }
  return null;
};

const sameGroup = (a: BonsaiRef | null, b: BonsaiRef | null) =>
  a?.groupKey === b?.groupKey;

export const BonsaiPanel = ({ excalidrawAPI }: Props) => {
  const [ref, setRef] = useState<BonsaiRef | null>(null);
  const [view, setView] = useState<ViewFields | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = useRef<BonsaiRef | null>(null);

  /**
   * A view closed by hand, ignored until something else is picked.
   *
   * Closing does not deselect - and a locked titleblock stays active for as
   * long as the editor shows its padlock - so without this the panel would
   * reopen the moment it was dismissed.
   */
  const dismissed = useRef<string | null>(null);

  // Selection changes on every pointer move over the canvas, so the panel only
  // reacts when the view itself changes - not on every frame of a drag.
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const check = (elements: readonly any[], appState: any) => {
      let picked =
        selectedGroup(elements, appState.selectedElementIds ?? {}) ??
        activeLocked(elements, appState.activeLockedId ?? null);
      if (dismissed.current && picked?.groupKey !== dismissed.current) {
        dismissed.current = null;
      } else if (dismissed.current) {
        picked = null;
      }
      // Once a view is open the panel holds on to it, rather than following the
      // editor's selection from one moment to the next. Saving replaces the
      // scene, and the editor drops a locked element's hold when that happens -
      // so the titleblock's panel would close the instant it was used. It stays
      // until another view is picked, its own is gone, or it is closed.
      const next = picked ?? stillThere(elements, current.current);
      if (sameGroup(next, current.current) && next?.layout === current.current?.layout) {
        return;
      }
      if (!sameGroup(next, current.current)) {
        // A different view: nothing of the last one should show while its
        // fields are on the way.
        setView(null);
        setEdited({});
        setStatus(null);
      }
      current.current = next;
      setRef(next);
    };
    check(excalidrawAPI.getSceneElements(), excalidrawAPI.getAppState());
    return excalidrawAPI.onChange(check);
  }, [excalidrawAPI]);

  // The same view at a new path is a refetch, not a new panel: the fields stay
  // on screen until the answer arrives, so a rename does not blink the panel
  // out of existence at the moment it is used.
  useEffect(() => {
    if (!ref) {
      return;
    }
    let live = true;
    api
      .bonsaiFields(ref)
      .then((answer) => {
        if (live) {
          setView(answer);
          setStatus((s) => (s?.startsWith("saved") ? s : null));
        }
      })
      .catch((error: Error) => live && setStatus(error.message));
    return () => {
      live = false;
    };
  }, [ref]);

  if (!ref || (!view && !status)) {
    return null;
  }

  const changed = Object.entries(edited).filter(
    ([name, value]) => value !== view?.fields.find((f) => f.name === name)?.value,
  );

  const save = async () => {
    if (!ref || changed.length === 0) {
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const { changed: applied, layout } = await api.setBonsaiValues(
        ref,
        Object.fromEntries(changed),
      );
      setStatus(applied.length ? `saved ${applied.join(", ")}` : "nothing changed");
      setEdited({});
      // Renaming a sheet moves its layout, so Bonsai answers with where it is
      // now and the panel follows it there. Setting the view again is what
      // fetches the values, so the boxes show the model rather than what was
      // typed - a name Bonsai adjusted shows up as it adjusted it.
      const moved: BonsaiRef = { ...ref, layout: layout || ref.layout };
      current.current = moved;
      setRef(moved);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="viewedit">
      <div className="viewedit__head">
        <div>
          <strong>{view?.view ?? "this view"}</strong>
          <span className="viewedit__sheet">{view?.sheet}</span>
        </div>
        <button
          className="linkish viewedit__close"
          title="Close"
          onClick={() => {
            dismissed.current = current.current?.groupKey ?? null;
            current.current = null;
            setRef(null);
            setView(null);
            setEdited({});
            setStatus(null);
          }}
        >
          ×
        </button>
      </div>

      {view?.note && <p className="viewedit__note">{view.note}</p>}

      {view?.fields.map((field) => (
        <label key={field.name} className="viewedit__field">
          <span title={field.editable ? undefined : field.reason}>
            {field.name}
            {!field.editable && " ·"}
          </span>
          <input
            value={edited[field.name] ?? field.value}
            disabled={!field.editable || saving}
            title={field.editable ? undefined : field.reason}
            onChange={(e) => setEdited((v) => ({ ...v, [field.name]: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
        </label>
      ))}

      <div className="viewedit__foot">
        <button disabled={changed.length === 0 || saving} onClick={() => void save()}>
          {saving ? "saving…" : "Save to Bonsai"}
        </button>
        {status && <span className="viewedit__status">{status}</span>}
      </div>
    </div>
  );
};

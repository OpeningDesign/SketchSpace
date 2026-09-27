/**
 * Picking a drawing to put on the sheet.
 *
 * The model's drawings, filtered by typing, chosen with the keyboard or the
 * mouse. Choosing one does not place it: the next click on the canvas does,
 * which is what decides where it goes. Placing is Bonsai's to do - it adds the
 * sheet's reference and the group in the layout - and the drawing reaches the
 * page the way anything Bonsai changes does.
 *
 * A drawing already on this sheet, or one never generated, is shown and not
 * offered: both are reasons Bonsai would refuse it, and a reason given here is
 * better than a refusal after pressing OK.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { api, type BonsaiDrawing } from "./api";

type Props = {
  layout: string;
  /**
   * What was placed just before this opened, if the dialog is coming back for
   * another. Putting several drawings on a sheet is one job, so it reopens
   * rather than making you find the menu again each time.
   */
  justAdded?: string | null;
  onPick: (drawing: BonsaiDrawing) => void;
  onClose: () => void;
};

export const AddDrawing = ({ layout, justAdded, onPick, onClose }: Props) => {
  const [drawings, setDrawings] = useState<BonsaiDrawing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    api
      .bonsaiDrawings(layout)
      .then((answer) => {
        if (!live) {
          return;
        }
        setDrawings(answer.drawings);
        if (!answer.connected) {
          setError("Open this model in Blender to add a drawing to the sheet.");
        }
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [layout]);

  useEffect(() => search.current?.focus(), [drawings]);

  const matches = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return (drawings ?? []).filter((d) =>
      words.every((word) => d.name.toLowerCase().includes(word)),
    );
  }, [drawings, filter]);

  // The highlight follows the list, not the other way round: filtering down to
  // three leaves it on the fourth otherwise.
  useEffect(() => setActive(0), [filter]);

  const pickable = (d: BonsaiDrawing) => !d.onSheet && d.generated;
  const why = (d: BonsaiDrawing) =>
    d.onSheet ? "already on this sheet" : d.generated ? "" : "not generated yet";

  const choose = (d: BonsaiDrawing | undefined) => {
    if (d && pickable(d)) {
      onPick(d);
    }
  };

  return (
    <div className="picker__scrim" onClick={onClose}>
      <div
        className="picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Add a drawing to this sheet"
      >
        <h2>Add drawing</h2>
        {justAdded && <p className="picker__added">Added {justAdded}. Another?</p>}

        <input
          ref={search}
          value={filter}
          placeholder="Filter by name…"
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, matches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              choose(matches[active]);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />

        {error && <p className="picker__error">{error}</p>}
        {!drawings && !error && <p className="picker__note">Asking Blender…</p>}
        {drawings && matches.length === 0 && (
          <p className="picker__note">
            {drawings.length === 0 ? "This model has no drawings." : "Nothing matches that."}
          </p>
        )}

        <ul className="picker__list">
          {matches.map((d, i) => (
            <li key={d.globalId}>
              <button
                className={`picker__item${i === active ? " is-active" : ""}`}
                disabled={!pickable(d)}
                title={why(d) || d.file}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(d)}
              >
                <span className="picker__name">{d.name}</span>
                {why(d) && <span className="picker__why">{why(d)}</span>}
              </button>
            </li>
          ))}
        </ul>

        <div className="picker__foot">
          <span className="picker__note">Then click where it should go.</span>
          {/*
            "Cancel" until something has been placed, "Done" after: once a
            drawing is on the sheet there is nothing left to cancel, and
            offering both would be two buttons for one outcome.
          */}
          <button onClick={onClose}>{justAdded ? "Done" : "Cancel"}</button>
          <button
            className="picker__ok"
            disabled={!pickable(matches[active] ?? ({} as BonsaiDrawing))}
            onClick={() => choose(matches[active])}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
};

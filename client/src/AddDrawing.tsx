/**
 * Picking something to put on the sheet.
 *
 * The model's drawings, schedules and references - the three things a sheet can
 * place, and the three Bonsai has its own Add … To Sheet commands for - filtered
 * by typing, chosen with the keyboard or the mouse. Choosing one does not place
 * it: the next click on the canvas does, which is what decides where it goes.
 * Placing is Bonsai's to do - it adds the sheet's reference and the group in the
 * layout - and it reaches the page the way anything Bonsai changes does.
 *
 * One already on this sheet, or one never generated, is shown and not offered:
 * both are reasons Bonsai would refuse it, and a reason given here is better
 * than a refusal after pressing OK.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { api, type BonsaiDrawing } from "./api";

type Props = {
  layout: string;
  onPick: (drawing: BonsaiDrawing) => void;
  onClose: () => void;
};

export const AddDrawing = ({ layout, onPick, onClose }: Props) => {
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

  // The kind counts as part of what is typed, so "schedule" narrows to the
  // schedules without having to name one.
  const matches = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return (drawings ?? []).filter((d) =>
      words.every(
        (word) => d.name.toLowerCase().includes(word) || d.kind.includes(word),
      ),
    );
  }, [drawings, filter]);

  // The highlight follows the list, not the other way round: filtering down to
  // three leaves it on the fourth otherwise.
  useEffect(() => setActive(0), [filter]);

  const pickable = (d: BonsaiDrawing) => !d.onSheet && d.generated;
  // A drawing is generated, a schedule rendered from its spreadsheet; either
  // way it is the missing SVG that stops it being placed.
  const why = (d: BonsaiDrawing) =>
    d.onSheet
      ? "already on this sheet"
      : d.generated
        ? ""
        : d.kind === "schedule"
          ? "not rendered yet"
          : "not generated yet";

  const heading = { drawing: "Drawings", schedule: "Schedules", reference: "References" };

  /**
   * The file it is placed from, shown when that is not simply its name.
   *
   * Bonsai names a schedule or reference on a sheet by its file, not by the
   * document's Name, and the two drift - a schedule called THINGER SCHEDULE can
   * live in DOOR SCHEDULE.ods. Showing both is what makes the same thing
   * recognisable in either tool. A drawing's file usually is its name, so this
   * stays empty for them.
   */
  const fileName = (d: BonsaiDrawing) => {
    // Bonsai answers with a Windows path, so both separators have to go.
    const base = d.file.split(/[/\\]/).pop() ?? "";
    return base.replace(/\.[^.]*$/, "");
  };
  const aside = (d: BonsaiDrawing) =>
    why(d) || (fileName(d) === d.name ? "" : fileName(d));

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
        aria-label="Add a drawing, schedule or reference to this sheet"
      >
        <h2>Add to sheet</h2>

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

        {/*
          Grouped by kind, which is the order Bonsai lists them in. A heading
          where the kind changes, rather than on every row: the list is mostly
          drawings, and repeating the word down the side of it says nothing.
        */}
        <ul className="picker__list">
          {matches.map((d, i) => (
            <li key={d.file || d.globalId}>
              {(i === 0 || matches[i - 1].kind !== d.kind) && (
                <h3 className="picker__kind">{heading[d.kind]}</h3>
              )}
              <button
                className={`picker__item${i === active ? " is-active" : ""}`}
                disabled={!pickable(d)}
                title={why(d) || d.file}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(d)}
              >
                <span className="picker__name">{d.name}</span>
                {aside(d) && <span className="picker__why">{aside(d)}</span>}
              </button>
            </li>
          ))}
        </ul>

        <div className="picker__foot">
          <span className="picker__note">Then click where it should go.</span>
          <button onClick={onClose}>Cancel</button>
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

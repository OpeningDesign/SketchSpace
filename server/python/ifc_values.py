"""
Extract the values Bonsai fills into sheet templates, from a saved IFC.

Bonsai renders view-titles and titleblocks as Mustache templates
(`SheetBuilder.parse_embedded_svg`, via pystache) at `create_sheets()` time.
SketchSpace renders the same templates from the layout, so it needs the same
data. This builds it the way `sheeter.py` does, and prints it as JSON:

    python ifc_values.py <path to .ifc>

    {
      "ifc": "<absolute path>",
      "sheets": [
        {
          "identification": "A01",
          "layout": "<absolute path of the sheet's LAYOUT reference>",
          "values": { ...sheet.get_info(), as text... },
          "placements": {
            "<absolute path of the placed drawing/document>": { ...view-title data... }
          },
          "drawings": { "<drawing GlobalId>": { ...the same data, for drawings... } }
        }
      ],
      "north": { "grid": "rotate(..)", "true": "rotate(..)" }
    }

Placements are keyed by the file they place, not by STEP id: the layout's
`data-id` does not survive a re-serialisation of the IFC (IfcOpenShell#9468),
while the file path does. Drawings are also keyed by GlobalId, for when the
two disagree on the file - a drawing renamed in Blender but not yet saved has
already been moved on disk and relinked in the layout, while this file still
names the old path.

Values are converted with str(), exactly as pystache would - so an unset
attribute renders as "None" here just as it does on Bonsai's built sheet.
Revisions (the titleblock's git tag table) are not built here; SketchSpace
reads them with git directly.

This reads the file on disk. The model open in Blender may have unsaved
changes, and those are not visible here - see NOTES.md.
"""

import json
import os
import sys

import ifcopenshell
import ifcopenshell.util.element
import ifcopenshell.util.geolocation

# Sheet references Bonsai uses for things that are not a placed document.
STRUCTURAL = {"LAYOUT", "TITLEBLOCK", "SHEET"}


def text(value):
    """Render a value the way pystache does, None included."""
    return str(value)


def as_text(data):
    return {k: text(v) for k, v in data.items()}


def references(document):
    if document.file.schema == "IFC2X3":
        return document.DocumentReferences or []
    return document.HasDocumentReferences or []


def description(reference):
    if reference.file.schema == "IFC2X3":
        return reference.Name
    return reference.Description


def human_scale(drawing):
    # tool.Drawing.get_drawing_human_scale
    pset = ifcopenshell.util.element.get_pset(drawing, "EPset_Drawing") or {}
    return "NTS" if pset.get("IsNTS", False) else pset.get("HumanScale", "NTS")


def is_perspective(drawing):
    # SheetBuilder.build_drawings. Bonsai catches only AttributeError; a drawing
    # with no representation items would raise IndexError there, so be wider.
    try:
        return drawing.Representation.Representations[0].Items[0].TreeRootExpression.FirstOperand.is_a(
            "IfcRectangularPyramid"
        )
    except (AttributeError, IndexError, TypeError):
        return False


def north(getter, model):
    try:
        return f"rotate({getter(model) * -1})"
    except Exception:
        return "rotate(0)"


def main(ifc_path):
    model = ifcopenshell.open(ifc_path)
    ifc_dir = os.path.dirname(os.path.abspath(ifc_path))

    def uri(location):
        # tool.Drawing.get_document_uri
        if os.path.isabs(location):
            return location
        return os.path.abspath(os.path.join(ifc_dir, location))

    def key(location):
        return os.path.normcase(uri(location))

    # Drawings, and the documents placed on sheets, by the file they point at.
    drawings = {}
    for annotation in model.by_type("IfcAnnotation"):
        if annotation.ObjectType != "DRAWING":
            continue
        for rel in annotation.HasAssociations:
            if rel.is_a("IfcRelAssociatesDocument"):
                location = getattr(rel.RelatingDocument, "Location", None)
                if location:
                    drawings[key(location)] = annotation
                break

    documents = {}
    for info in model.by_type("IfcDocumentInformation"):
        if getattr(info, "Scope", None) in (None, "SHEET"):
            continue
        for ref in references(info):
            if ref.Location:
                documents.setdefault(key(ref.Location), info)

    sheets = []
    for sheet in model.by_type("IfcDocumentInformation"):
        if getattr(sheet, "Scope", None) != "SHEET":
            continue
        refs = references(sheet)
        layout = next(
            (uri(r.Location) for r in refs if description(r) == "LAYOUT" and r.Location),
            None,
        )
        if not layout:
            continue

        sheet_info = sheet.get_info()
        placements = {}
        by_drawing = {}
        for ref in refs:
            kind = description(ref)
            if kind in STRUCTURAL or not ref.Location:
                continue

            # SheetBuilder.build_drawings / build_documents
            data = ref.get_info()
            data.update({"Sheet" + k: v for k, v in sheet_info.items()})
            if kind == "DRAWING":
                if not data["Name"]:
                    data["Name"] = os.path.basename(ref.Location)[0:-4]
                drawing = drawings.get(key(ref.Location))
                if drawing is not None and not is_perspective(drawing):
                    data["Scale"] = human_scale(drawing)
            else:
                if not data["Name"]:
                    document = documents.get(key(ref.Location))
                    data["Name"] = (document.Name if document is not None else None) or "Unnamed"

            placements[uri(ref.Location)] = as_text(data)
            if kind == "DRAWING" and drawing is not None:
                by_drawing[drawing.GlobalId] = as_text(data)

        sheets.append(
            {
                "identification": text(getattr(sheet, "Identification", None)),
                "layout": layout,
                "drawings": by_drawing,
                "values": as_text(sheet_info),
                "placements": placements,
            }
        )

    return {
        "ifc": os.path.abspath(ifc_path),
        "sheets": sheets,
        "north": {
            "grid": north(ifcopenshell.util.geolocation.get_grid_north, model),
            "true": north(ifcopenshell.util.geolocation.get_true_north, model),
        },
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: ifc_values.py <path to .ifc>"}))
        sys.exit(2)
    try:
        print(json.dumps(main(sys.argv[1])))
    except Exception as error:  # reported to the server, which logs it
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}))
        sys.exit(1)

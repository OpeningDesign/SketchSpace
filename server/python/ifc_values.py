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
          "values": { ...sheet.get_info(), its site and building, as text... },
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


def with_ext(path, ext):
    # tool.Drawing.get_path_with_ext
    return os.path.splitext(path)[0] + f".{ext}"


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


# SheetBuilder's SPATIAL_ELEMENTS: {{Site...}} and {{Building...}} fields, the
# class behind each prefix, and the attribute holding its postal address.
SPATIAL_ELEMENTS = {"Site": ("IfcSite", "SiteAddress"), "Building": ("IfcBuilding", "BuildingAddress")}
ELEMENT_ATTRIBUTES = ("Name", "Description")
ADDRESS_ATTRIBUTES = ("AddressLines", "PostalBox", "Town", "Region", "PostalCode", "Country")


def sheet_associations(sheet):
    if sheet.file.schema == "IFC2X3":
        return [r for r in sheet.file.by_type("IfcRelAssociatesDocument") if r.RelatingDocument == sheet]
    return list(sheet.DocumentInfoForObjects or [])


def containing(element, ifc_class):
    parent = ifcopenshell.util.element.get_aggregate(element)
    while parent is not None and not parent.is_a(ifc_class):
        parent = ifcopenshell.util.element.get_aggregate(parent)
    return parent


def only(elements):
    return elements[0] if len(elements) == 1 else None


def top_level_sites(model):
    sites = []
    for site in model.by_type("IfcSite"):
        parent = ifcopenshell.util.element.get_aggregate(site)
        if parent is None or parent.is_a("IfcProject"):
            sites.append(site)
    return sites


def buildings_in(model, site):
    if site is None:
        return [b for b in model.by_type("IfcBuilding") if not containing(b, "IfcBuilding")]
    found, queue = [], [site]
    while queue:
        for part in ifcopenshell.util.element.get_parts(queue.pop()):
            if part.is_a("IfcBuilding"):
                found.append(part)
            elif part.is_a("IfcSite"):
                queue.append(part)
    return found


def sheet_spatial(sheet):
    """SheetBuilder.get_sheet_spatial: what the sheet links to, else the only candidate.

    Two links of one kind count as none (SheetBuilder.get_sheet_links): IFC keeps
    them as a set, so taking the first would be a guess.
    """
    linked = {prefix: [] for prefix in SPATIAL_ELEMENTS}
    for rel in sheet_associations(sheet):
        for element in rel.RelatedObjects:
            for prefix, (ifc_class, _) in SPATIAL_ELEMENTS.items():
                if element.is_a(ifc_class) and element not in linked[prefix]:
                    linked[prefix].append(element)
    site, building = only(linked["Site"]), only(linked["Building"])
    if site is None and building is not None:
        site = containing(building, "IfcSite")
    if site is None:
        site = only(top_level_sites(sheet.file))
    if building is None:
        building = only(buildings_in(sheet.file, site))
    return {"Site": site, "Building": building}


def spatial_data(sheet):
    """SheetBuilder.get_spatial_data. Unset values are empty, not "None" - Bonsai's choice."""

    def get(entity, name):
        return (getattr(entity, name, None) if entity else None) or ""

    data = {}
    for prefix, element in sheet_spatial(sheet).items():
        address = get(element, SPATIAL_ELEMENTS[prefix][1]) or None
        for name in ELEMENT_ATTRIBUTES:
            data[prefix + name] = get(element, name)
        for name in ADDRESS_ATTRIBUTES:
            data[prefix + name] = get(address, name)
        data[prefix + "AddressLines"] = ", ".join(get(address, "AddressLines"))
        region = " ".join(p for p in (data[prefix + "Region"], data[prefix + "PostalCode"]) if p)
        parts = (
            data[prefix + "AddressLines"],
            data[prefix + "PostalBox"],
            data[prefix + "Town"],
            region,
            data[prefix + "Country"],
        )
        data[prefix + "Address"] = ", ".join(p for p in parts if p)
    return data


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

    # SheetBuilder._documents_by_uri. A schedule is kept as a spreadsheet and
    # placed as the SVG rendered beside it (SheetBuilder.add_document), so the
    # sheet's reference names a file the document itself never does. Both
    # spellings are keyed, or a schedule's view-title would read "Unnamed".
    documents = {}
    for info in model.by_type("IfcDocumentInformation"):
        if getattr(info, "Scope", None) not in ("SCHEDULE", "REFERENCE"):
            continue
        for ref in references(info):
            if ref.Location:
                for location in (ref.Location, with_ext(ref.Location, "svg")):
                    documents.setdefault(key(location), info)

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
                # SheetBuilder.get_titleblock_data
                "values": as_text({**sheet_info, **spatial_data(sheet)}),
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

dojo.provide("sketchSpaceDesigner.designer.selection");

dojo.require("sketchSpaceDesigner.designer.bbox");

dojo.declare("sketchSpaceDesigner.designer.selection.Selection", [], {
  constructor: function (designer) {
    this.designer = designer;
    this.objects = {};
    this.parent = undefined;
    this.imageUpdatedHandle = dojo.connect(this.designer, "imageUpdated", this, this.imageUpdated);
  },

  selectionUpdated: function () {},

  imageUpdated: function () {
    if (this.objects != {}) {
      var selection = this;
      var objects = {};
      this.designer.forEachObjectShape(function (shape) {
	if (selection.objects[shape.objId] !== undefined)
	  objects[shape.objId] = shape;
      });
      this.objects = objects;
    }
    this.selectionUpdated();
  },

  getBbox: function() {
    var bbox = new sketchSpaceDesigner.designer.bbox.Bbox();
    for (objId in this.objects) {
      bbox.addPoints(this.objects[objId].getTransformedBoundingBox());
    }
    return bbox;
  },

  addShape: function(shape) {
    if (shape.objId === undefined) return;
    if (this.parent !== shape.parent) {
      this.objects = {};
      this.parent = shape.parent;
    }
    this.objects[shape.objId] = shape;
    this.selectionUpdated();
  },

  shapeIsSelected: function(shape) {
    return shape.objId !== undefined && this.objects[shape.objId] !== undefined;
  },

  removeShape: function(shape) {
    if (shape.objId === undefined || this.objects[shape.objId] === undefined) return;
    delete this.objects[shape.objId];
    this.selectionUpdated();
  },

  toggleShape: function(shape, clearOthers) {
    var isSelected = this.shapeIsSelected(shape);
    if (clearOthers)
      this.clear();
    if (isSelected)
      this.removeShape(shape);
    else
      this.addShape(shape);
  },

  clear: function () {
    this.objects = {};
    this.selectionUpdated();
  },

  applyToShapes: function () {
   /* applyToShapes(op, arg1, arg2...argn) results in
      shape[OP](arg1, arg2...argn) */

    var op = arguments[0];
    var arg = Array.prototype.slice.call(arguments, 1, arguments.length);

    for (objId in this.objects) {
      if (typeof(op) == "function") {
        op.apply(this.objects[objId], arg);
      } else if (op == "removeShape") {
        this.designer.editorShapeRemove(this.objects[objId]);
      } else if (op == "save") {
        this.designer.saveShapeToStr(this.objects[objId]);
      } else {
        this.objects[objId][op].apply(this.objects[objId], arg);
        this.designer.saveShapeToStr(this.objects[objId]);
      }
    }
  }
});
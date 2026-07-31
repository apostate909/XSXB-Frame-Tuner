(function bindXsxbTransformSelection(globalScope) {
  "use strict";

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : Number(fallback || 0);
  }

  function normalizeTransform(transform = {}) {
    const scale = numberOr(transform.scale, 1);
    return {
      scale,
      scaleX: numberOr(transform.scaleX, scale),
      scaleY: numberOr(transform.scaleY, scale),
      offset: {
        x: numberOr(transform.offset?.x, 0),
        y: numberOr(transform.offset?.y, 0),
      },
      rotation: numberOr(transform.rotation, 0),
    };
  }

  function applyEditedField(previousTransform, editedTransform, field, referenceTransform = null) {
    const previous = normalizeTransform(previousTransform);
    const edited = normalizeTransform(editedTransform);
    const reference = referenceTransform ? normalizeTransform(referenceTransform) : null;
    const next = normalizeTransform(previous);

    if (field === "scale") {
      next.scale = edited.scale;
      next.scaleX = edited.scaleX;
      next.scaleY = edited.scaleY;
    } else if (field === "scaleX") {
      next.scaleX = edited.scaleX;
    } else if (field === "scaleY") {
      next.scaleY = edited.scaleY;
    } else if (field === "offsetX") {
      next.offset.x = reference
        ? previous.offset.x + edited.offset.x - reference.offset.x
        : edited.offset.x;
    } else if (field === "offsetY") {
      next.offset.y = reference
        ? previous.offset.y + edited.offset.y - reference.offset.y
        : edited.offset.y;
    } else if (field === "rotation") {
      next.rotation = edited.rotation;
    } else {
      return edited;
    }
    return next;
  }

  const api = { applyEditedField, normalizeTransform };
  globalScope.XsxbTransformSelection = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

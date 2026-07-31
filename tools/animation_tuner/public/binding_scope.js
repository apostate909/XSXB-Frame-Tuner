(function bindXsxbBindingScope(globalScope) {
  "use strict";

  function dataProjectIds(config = {}) {
    const values = Array.isArray(config.dataProjectIds) ? config.dataProjectIds : [];
    return [...new Set(values.map((value) => String(value || "")).filter(Boolean))];
  }

  function bindingProjectId(config = {}) {
    return String(config.bindingProjectId || dataProjectIds(config)[0] || config.activeProjectId || "");
  }

  function containsProjectId(config, projectId) {
    const value = String(projectId || "");
    if (!value || value === "legacy") return true;
    const aliases = dataProjectIds(config);
    return value === bindingProjectId(config) || aliases.includes(value);
  }

  function canonicalProjectId(config, projectId) {
    return containsProjectId(config, projectId) ? bindingProjectId(config) : String(projectId || "");
  }

  function bindingKey(config, key, metadata = {}) {
    const authorityId = bindingProjectId(config);
    const frame = Number(metadata.frame);
    if (metadata.animation && Number.isFinite(frame)) {
      return [
        authorityId,
        metadata.tuningTarget || "player",
        metadata.profileId || "all",
        metadata.groupType || "animation",
        metadata.animation,
        metadata.source || "",
        frame,
      ].join(":");
    }
    const parts = String(key || "").split(":");
    if (parts.length >= 7 && containsProjectId(config, parts[0])) {
      parts[0] = authorityId;
      return parts.join(":");
    }
    return String(key || "");
  }

  const api = { bindingKey, bindingProjectId, canonicalProjectId, containsProjectId, dataProjectIds };
  globalScope.XsxbBindingScope = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

(function initAnimationFamilies(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XsxbAnimationFamilies = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function animationFamiliesFactory() {
  const FAMILY_ORDER = Object.freeze([
    "rope_dart",
    "movement",
    "combat",
    "state",
    "vfx",
    "props",
    "other",
  ]);

  function animationIdentity(group) {
    return [
      group?.name,
      group?.runtimeAnimation,
      group?.skillName,
      group?.source,
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function animationFamilyId(group) {
    const identity = animationIdentity(group);
    const type = String(group?.type || "").toLowerCase();

    if (/(^|[\/_\s-])(?:rope[\/_\s-]*)?dart($|[\/_\s-])/.test(identity)) return "rope_dart";
    if (type === "vfx" || /(^|[\/_\s-])vfx($|[\/_\s-])/.test(identity)) return "vfx";
    if (type === "prop" || type === "scene_prop_attachment") return "props";
    if (/(^|[\/_\s-])(death|die|defeat|hurt|damage|heal|stun|knockback|brace|recover|spawn|appear|disappear|transform)(?=$|[\/_\s-])/.test(identity)) return "state";
    if (/(^|[\/_\s-])(attack|combo|strike|slash|parry|counter|cast|shoot|fire|throw|laser|lunge|thrust|skill|punch|kick|kill)(?=$|[\/_\s-]|\d)/.test(identity)) return "combat";
    if (/(^|[\/_\s-])(idle|walk|run|move|jump|fall|land|crouch|slide|dash|roll|turn|climb)(?=$|[\/_\s-]|\d)/.test(identity)) return "movement";
    return "other";
  }

  function organizeAnimationGroups(groups, options = {}) {
    const includeProfile = options.includeProfile === true;
    const sections = new Map();
    const profileOrder = new Map();

    for (const group of Array.isArray(groups) ? groups : []) {
      const profileId = String(group?.profileId || "unbound");
      if (!profileOrder.has(profileId)) profileOrder.set(profileId, profileOrder.size);
      const familyId = animationFamilyId(group);
      const key = `${includeProfile ? profileId : ""}::${familyId}`;
      if (!sections.has(key)) {
        sections.set(key, {
          profileId,
          profileLabel: String(group?.profileLabel || profileId),
          familyId,
          groups: [],
        });
      }
      sections.get(key).groups.push(group);
    }

    return Array.from(sections.values()).sort((left, right) => {
      if (includeProfile && left.profileId !== right.profileId) {
        return profileOrder.get(left.profileId) - profileOrder.get(right.profileId);
      }
      return FAMILY_ORDER.indexOf(left.familyId) - FAMILY_ORDER.indexOf(right.familyId);
    });
  }

  return {
    FAMILY_ORDER,
    animationFamilyId,
    animationIdentity,
    organizeAnimationGroups,
  };
});

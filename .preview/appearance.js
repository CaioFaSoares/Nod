// src/appearance.ts
var current = { skin: "atrius", theme: "auto", colors: { light: {}, dark: {} } };
var themeName = "dark";
var darkQuery = null;
var SLOT_TOKENS = {
  atrius: {
    accent: ["--brand"],
    info: ["--state-run"],
    warning: ["--state-wait"],
    success: ["--state-ok"],
    error: ["--state-error"]
  },
  sober: {
    accent: ["--solid-bg"],
    info: ["--state-run"],
    warning: ["--state-wait"],
    error: ["--brand", "--state-error"]
  }
};
var OFFERED_SLOTS = {
  atrius: ["accent", "info", "warning", "success", "error"],
  sober: ["accent", "info", "warning", "error"]
};
var SLOT_LABELS = {
  accent: "Accent",
  info: "Info",
  warning: "Caution",
  success: "Success",
  error: "Failure"
};
var SLOT_HINTS = {
  atrius: {
    accent: "Atrius wears one colour for authority and failure: danger buttons, error rules and the failed state all follow it.",
    info: "Running and loading states, and plain notices.",
    warning: "What waits for you: a manual sign-in, a personal tool, offline.",
    success: "Signed in, saved, connected.",
    error: "Atrius fails in its accent; a colour here splits the two apart."
  },
  sober: {
    accent: "Sober's one green: the solid button, the focus ring, the open tool and the current item's bar. Success wears it too.",
    info: "Loading and queued states, and plain notices.",
    warning: "What waits for you: a manual sign-in, a personal tool, offline.",
    error: "Failures, and the acts that remove or revoke."
  }
};
function offeredColorSlots(skin) {
  return OFFERED_SLOTS[skin].map((slot) => ({
    slot,
    label: SLOT_LABELS[slot],
    hint: SLOT_HINTS[skin][slot] ?? ""
  }));
}
function resolvedTheme() {
  return themeName;
}
function slotProperty(skin, slot) {
  return SLOT_TOKENS[skin][slot]?.[0] ?? null;
}
function cssColorToHex(value) {
  if (value.trim() === "")
    return null;
  const probe = document.createElement("span");
  probe.style.color = value;
  probe.hidden = true;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(resolved);
  if (match === null)
    return null;
  const hex = match.slice(1, 4).map((part) => Math.round(Number(part)).toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}
function colorOfSlot(slot) {
  const property = slotProperty(current.skin, slot);
  if (property === null)
    return "#000000";
  const resolved = cssColorToHex(`var(${property})`);
  return resolved ?? "#000000";
}
function applyAppearance(next) {
  current = next;
  if (darkQuery === null && typeof window.matchMedia === "function") {
    darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    darkQuery.addEventListener("change", () => {
      if (current.theme !== "auto")
        return;
      const resolved = darkQuery?.matches === true ? "dark" : "light";
      if (resolved === themeName)
        return;
      applyAppearance(current);
      window.dispatchEvent(new Event("nod:appearance"));
    });
  }
  themeName = current.theme === "auto" ? darkQuery !== null && darkQuery.matches ? "dark" : "light" : current.theme;
  const root = document.documentElement;
  root.dataset.skin = current.skin;
  root.dataset.theme = themeName;
  for (const tokens of Object.values(SLOT_TOKENS)) {
    for (const names of Object.values(tokens))
      for (const name of names ?? [])
        root.style.removeProperty(name);
  }
  const colors = current.colors[themeName];
  for (const [slot, value] of Object.entries(colors)) {
    const names = SLOT_TOKENS[current.skin][slot];
    for (const name of names ?? [])
      root.style.setProperty(name, value);
  }
}
export {
  applyAppearance,
  colorOfSlot,
  offeredColorSlots,
  resolvedTheme
};

"use strict";

// Each Tools panel owns its context. A background panel may finish loading
// after the visible one, so arrival order cannot decide what the chat sees.
function create() {
  const states = new Map();
  let lastActive = null;

  function update(panel, state) {
    if (state === null) {
      states.delete(panel);
      if (lastActive === panel) lastActive = null;
    } else if (state === undefined) {
      if (states.has(panel)) lastActive = panel;
    } else {
      states.set(panel, state);
      if (panel.active) lastActive = panel;
    }
  }

  function current() {
    for (const [panel, state] of states) if (panel.active) return state;
    return lastActive ? states.get(lastActive) || null : null;
  }

  return { update, current };
}

module.exports = { create };

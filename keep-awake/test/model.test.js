import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODE_KEY, DEFAULT_MODE, TITLE, MODES, parseMode, modeLabel, isActive, statusText, tooltip, canKeepAwake,
} from "../mods/keep-awake/model.js";

// One agents() entry (herdr.d.ts AgentInfo, only what the decision reads).
const agent = (status) => ({ terminal: `t-${status}`, status, app: "claude-code" });

test("MODES: On / Agent / Off, one per row in the popup's order, Orca's descriptions verbatim (S3, D4)", () => {
  assert.deepEqual(MODES, [
    { value: "on", label: "On", description: "Keep this computer awake continuously" },
    { value: "agent", label: "Agent", description: "Stay awake while an agent is working" },
    { value: "off", label: "Off", description: "Allow normal system sleep behavior" },
  ]);
  assert.ok(Object.isFrozen(MODES) && MODES.every(Object.isFrozen));
});

test("the popup's title and the shared key (S2, D4)", () => {
  assert.equal(TITLE, "Keep computer awake");
  assert.equal(MODE_KEY, "keep-awake.mode");
  assert.equal(DEFAULT_MODE, "off");
});

test("parseMode keeps on, agent and off; anything else (unset included) is off (D4)", () => {
  for (const m of ["on", "agent", "off"]) assert.equal(parseMode(m), m);
  for (const v of [undefined, null, "", "auto", "On", " on", "AGENT", 1, true, {}, ["on"]]) {
    assert.equal(parseMode(v), "off", JSON.stringify(v));
  }
});

test("modeLabel: On, Agent, Off; an unknown mode reads Off (D4)", () => {
  assert.equal(modeLabel("on"), "On");
  assert.equal(modeLabel("agent"), "Agent");
  assert.equal(modeLabel("off"), "Off");
  assert.equal(modeLabel("auto"), "Off");
  assert.equal(modeLabel(undefined), "Off");
});

test("isActive: each mode × agents (none, working, blocked, done, idle, mixed) (D5)", () => {
  const sets = {
    none: [],
    working: [agent("working")],
    blocked: [agent("blocked")],
    done: [agent("done")],
    idle: [agent("idle")],
    "mixed with one working": [agent("blocked"), agent("idle"), agent("working"), agent("done")],
    "mixed, none working": [agent("blocked"), agent("done"), agent("idle")],
  };
  const expected = {
    on: { none: true, working: true, blocked: true, done: true, idle: true, "mixed with one working": true, "mixed, none working": true },
    agent: { none: false, working: true, blocked: false, done: false, idle: false, "mixed with one working": true, "mixed, none working": false },
    off: { none: false, working: false, blocked: false, done: false, idle: false, "mixed with one working": false, "mixed, none working": false },
  };
  for (const [mode, row] of Object.entries(expected)) {
    for (const [name, agents] of Object.entries(sets)) {
      assert.equal(isActive(mode, agents), row[name], `${mode} × ${name}`);
    }
  }
});

test("isActive: an unknown mode is off, even with a working agent; no agents list counts as none (D4, D5)", () => {
  for (const mode of [undefined, null, "auto", "ON"]) {
    assert.equal(isActive(mode, [agent("working")]), false, String(mode));
  }
  assert.equal(isActive("on", null), true);
  assert.equal(isActive("agent", null), false);
  assert.equal(isActive("agent", undefined), false);
  assert.equal(isActive("agent", [null, {}, { status: null }]), false);
});

test("statusText: `${label} · ${Active|Inactive}`, the three of S2 verbatim (S2, D8)", () => {
  assert.equal(statusText("on", true), "On · Active");
  assert.equal(statusText("agent", false), "Agent · Inactive");
  assert.equal(statusText("off", false), "Off · Inactive");
  assert.equal(statusText("agent", true), "Agent · Active");
  assert.equal(statusText("on", false), "On · Inactive");
  assert.equal(statusText("auto", false), "Off · Inactive");
});

test("tooltip: Orca's text verbatim around the status (D8)", () => {
  assert.equal(
    tooltip("On · Active"),
    "Keep computer awake, On · Active. Prevents idle sleep with the lid open; closing the lid still puts this Mac to sleep.",
  );
  assert.equal(
    tooltip(statusText("agent", false)),
    "Keep computer awake, Agent · Inactive. Prevents idle sleep with the lid open; closing the lid still puts this Mac to sleep.",
  );
});

test("canKeepAwake: only a macOS window; herdr-app check (no window) and other systems hold nothing (D6)", () => {
  assert.equal(canKeepAwake({ platform: "macos", titlebar: "none" }), true);
  assert.equal(canKeepAwake({ platform: "linux" }), false);
  assert.equal(canKeepAwake({ platform: "windows" }), false);
  assert.equal(canKeepAwake(null), false);
  assert.equal(canKeepAwake(undefined), false);
});

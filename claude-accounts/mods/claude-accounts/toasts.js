// What the footer tells the person when the CLI's files change (D1, D8, D13).
// Pure: no herdr or gpui-kit import, so `node --test` loads it.
//
// react({ restart, pendingSwitch, loginLink }, seen) → { notify, openConfirm, copyLink }
//   restart, pendingSwitch, loginLink: store.js's readings of restart.json,
//   pending-switch.json and login-link.
//   seen: shared("claude-accounts.seen"), what was already shown, keyed by
//   item id and state, so each toast shows once.
//   notify: the toasts to post now (herdr's notify argument each);
//   openConfirm: true when the confirm view should open; copyLink: the
//   sign-in URL to put on the clipboard, or null.
// The footer applies the result. The mod never writes restart.json.
//
// Owner: T7, which fills it. T1's stub has nothing to say, so T6's footer can
// apply it before T7 lands.

export function react(_state, _seen) {
  return { notify: [], openConfirm: false, copyLink: null };
}

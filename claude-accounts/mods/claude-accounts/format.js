// How the views say things (D4, D5, D10, D11). Pure: no herdr or gpui-kit
// import, so `node --test` loads it.
//
// Owner: T11, which makes it final and tested, then frozen. T1 stubs the
// final exports; each throws until T11 fills it.
//
//   formatPercent(p)              "41%"
//   formatDuration(ms)            "3h 2m", "4d 6h"
//   formatResetsIn(resetsAt, now) "Resets in 3h 2m"
//   formatDate(ms)                "Nov 2, 5:25 PM"
//   formatUpdated(at, now)        "Updated 3m ago", or "Not yet updated"
//   colorToken(percent)           the theme token (D5): under 60 "muted",
//                                 60–79 "working", 80 or more "blocked"
//   errorCopy(kind, detail)       { label, message } for each of D9's error
//                                 values and for "needsSignIn", Orca's copy
//                                 (D4's table)
//   densityLevel(width)           the footer's level for its width: bars and
//                                 labels, then one number per window, then
//                                 the icon only (D10)
//   formatSince(date)             "since <date>", for cache figures that start
//                                 after the range does (D11)

const notYet = (what) => new Error(`format.${what}: not implemented yet (T11)`);

export function formatPercent(_p) {
  throw notYet("formatPercent");
}

export function formatDuration(_ms) {
  throw notYet("formatDuration");
}

export function formatResetsIn(_resetsAt, _now) {
  throw notYet("formatResetsIn");
}

export function formatDate(_ms) {
  throw notYet("formatDate");
}

export function formatUpdated(_at, _now) {
  throw notYet("formatUpdated");
}

export function colorToken(_percent) {
  throw notYet("colorToken");
}

export function errorCopy(_kind, _detail) {
  throw notYet("errorCopy");
}

export function densityLevel(_width) {
  throw notYet("densityLevel");
}

export function formatSince(_date) {
  throw notYet("formatSince");
}

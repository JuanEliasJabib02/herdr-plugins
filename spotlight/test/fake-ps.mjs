// Shared by the tests that fake `ps` (ports, server, reconcile-orca): not a
// test file itself (it doesn't match *.test.js).
//
// ports.js runs every lstart read as `/usr/bin/env LC_ALL=C TZ=UTC ps …`
// (H7). unwrapEnv(file, args) gives the program and args under the env
// words, and those words: { file, args, env }, `env` null for a call that
// isn't wrapped. Words that only assign (no program after them) give
// { file: null, args: [], env }.
export function unwrapEnv(file, args = []) {
  if (file !== "/usr/bin/env") return { file, args, env: null };
  const env = {};
  let i = 0;
  while (i < args.length && /^[A-Za-z_]\w*=/.test(args[i])) {
    const at = args[i].indexOf("=");
    env[args[i].slice(0, at)] = args[i].slice(at + 1);
    i += 1;
  }
  if (i >= args.length) return { file: null, args: [], env };
  return { file: args[i], args: args.slice(i + 1), env };
}

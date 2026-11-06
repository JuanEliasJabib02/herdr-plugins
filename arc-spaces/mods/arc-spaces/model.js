// What the settings dialog stores, with nothing of Herdr's in it so tests can
// import it. bin/open reads the same two keys from shared.json at each click.

// { enabled: boolean, names: { [groupId]: string } }: off until someone turns
// it on, as in Orca. By group id, so renaming a group keeps its Arc space.
export const KEY = "arc-spaces.v1";
// projects-sidebar's registry: { groups: [{ id, name, projects }], activeGroup }.
export const GROUPS_KEY = "projects.v1";
// Where the wrapper has to be for Herdr to find it before /usr/bin/open.
export const LINK = "/usr/local/bin/open";

// `readlink /usr/local/bin/open` printed the installed wrapper of this home.
export const isLinked = (readlinkOutput, home) => readlinkOutput.trim() === `${home}/mods/arc-spaces/bin/open`;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseConfig(value) {
  const source = isObject(value) ? value : {};
  const names = isObject(source.names) ? source.names : {};
  return {
    enabled: source.enabled === true,
    names: Object.fromEntries(Object.entries(names).filter(([, name]) => typeof name === "string")),
  };
}

// These two return the same object when nothing changes, so the dialog can skip
// the write: setShared re-renders every mod.
export const withEnabled = (config, enabled) => (config.enabled === enabled ? config : { ...config, enabled });

// A blank name removes the group's entry, which is how a group stays out.
export function withName(config, groupId, rawName) {
  const name = rawName.trim();
  if ((config.names[groupId] ?? "") === name) return config;
  const names = { ...config.names };
  if (name) names[groupId] = name;
  else delete names[groupId];
  return { ...config, names };
}

export function groupsOf(registry) {
  const groups = isObject(registry) && Array.isArray(registry.groups) ? registry.groups : [];
  return groups
    .filter((group) => isObject(group) && typeof group.id === "string")
    .map(({ id, name }) => ({ id, name: typeof name === "string" ? name : id }));
}

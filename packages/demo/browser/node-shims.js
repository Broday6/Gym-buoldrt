/**
 * Stand-ins for the Node built-ins the bundled modules import but never call
 * in a browser. `SiteRegistry` imports `node:fs` for its optional config file
 * and only touches it inside `load()`, which the browser build does not use —
 * but the import still has to resolve, so it resolves to this.
 *
 * They throw rather than returning something plausible: if a code path in the
 * browser ever does reach one, the failure should be obvious rather than
 * silently producing an empty config.
 */
const unavailable = (name) => () => {
  throw new Error(`${name} is not available in the browser build`);
};

export const existsSync = () => false;
export const readFileSync = unavailable('readFileSync');
export const writeFileSync = unavailable('writeFileSync');
export const readdirSync = unavailable('readdirSync');
export const mkdirSync = unavailable('mkdirSync');
export const statSync = unavailable('statSync');
export const unlinkSync = unavailable('unlinkSync');
export default { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, unlinkSync };

/** Path helpers `SiteRegistry` uses to locate its optional config file. */
export const dirname = (p) => String(p).replace(/\/[^/]*$/, '');
export const join = (...parts) => parts.filter(Boolean).join('/');
export const resolve = (...parts) => join(...parts);
export const fileURLToPath = (u) => String(u);

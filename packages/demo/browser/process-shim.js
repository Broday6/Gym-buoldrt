/**
 * A `process` for the browser.
 *
 * Several bundled modules read tuning knobs from the environment — the ranking
 * window, the SEO base URL. There is no environment in a page, so they see an
 * empty one and fall back to the same defaults a server does with nothing set.
 */
export const process = { env: {}, argv: [], platform: 'browser' };

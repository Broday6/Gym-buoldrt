export { CompassClient, debounceAsync } from './client.js';
export { ResultsWidget, SORT_OPTIONS, esc } from './results.js';

import { CompassClient } from './client.js';
import { ResultsWidget } from './results.js';

/**
 * One-call install for a storefront template:
 *
 *   Compass.init({ site: 'ekena', baseUrl: 'https://search.example.com',
 *                  apiKey: 'ck_search_…', results: '#search-results' });
 */
export function init(options) {
  const client = new CompassClient(options);
  const widgets = { client };

  if (options.results) {
    widgets.results = new ResultsWidget({ ...options, client, container: options.results });
    widgets.results.readUrl();
    void widgets.results.render();
  }

  if (options.searchInput) {
    const input = typeof options.searchInput === 'string'
      ? document.querySelector(options.searchInput)
      : options.searchInput;
    input?.closest('form')?.addEventListener('submit', (event) => {
      if (!widgets.results) return;
      event.preventDefault();
      void widgets.results.setQuery(input.value);
    });
  }

  return widgets;
}

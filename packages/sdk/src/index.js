export { CompassClient, debounceAsync } from './client.js';
export { ResultsWidget, SORT_OPTIONS, esc } from './results.js';
export { AutocompleteWidget } from './autocomplete.js';
export { FacetsWidget } from './facets.js';

import { CompassClient } from './client.js';
import { ResultsWidget } from './results.js';
import { AutocompleteWidget } from './autocomplete.js';
import { FacetsWidget } from './facets.js';

/**
 * One-call install for a storefront template:
 *
 *   Compass.init({
 *     site: 'ekena',
 *     baseUrl: 'https://search.example.com',
 *     apiKey: 'ck_search_…',
 *     searchInput: '#site-search',
 *     results: '#search-results',
 *     facets: '#search-facets',
 *   });
 *
 * Every widget is independently constructible; this just wires the common
 * arrangement — autocomplete on the existing box, a results grid, and facets
 * that drive it — and connects them to each other.
 */
export function init(options) {
  const client = new CompassClient(options);
  const widgets = { client };

  if (options.results) {
    widgets.results = new ResultsWidget({ ...options, client, container: options.results });
  }

  if (options.facets && widgets.results) {
    widgets.facets = new FacetsWidget({
      ...options,
      container: options.facets,
      onChange: ({ filters, ranges, labelFilters }) => {
        void widgets.results.setFilters(filters, ranges, labelFilters);
      },
      // The mobile modal needs a count for its apply button before the
      // selection is applied, which is a separate, hit-less query.
      onPreview: async (selection) => {
        const count = await widgets.results.previewCount(selection);
        if (count !== null) widgets.facets.setPreviewCount(count);
      },
    });

    const userOnStateChange = options.onStateChange;
    widgets.results.onStateChange = (response, state) => {
      widgets.facets.update(response);
      userOnStateChange?.(response, state);
    };
  }

  if (options.searchInput) {
    const input = typeof options.searchInput === 'string'
      ? document.querySelector(options.searchInput)
      : options.searchInput;

    if (input) {
      widgets.autocomplete = new AutocompleteWidget({
        ...options,
        client,
        input,
        // With a results grid on the page, selecting a suggestion should
        // re-run the grid in place rather than navigate away from it.
        onSubmit: widgets.results
          ? (query) => {
              void widgets.results.setQuery(query);
              return false;
            }
          : options.onSubmit,
        onSelect: widgets.results
          ? (payload) => {
              if (payload.kind !== 'query') return options.onSelect?.(payload);
              void widgets.results.setQuery(payload.query);
              return false;
            }
          : options.onSelect,
      });

      input.closest('form')?.addEventListener('submit', (event) => {
        if (!widgets.results) return;
        event.preventDefault();
        void widgets.results.setQuery(input.value);
      });
    }
  }

  if (widgets.results) {
    widgets.results.readUrl();
    if (widgets.facets && Object.keys(widgets.results.state.filters).length) {
      widgets.facets.applied = widgets.results.state.filters;
    }
    void widgets.results.render();
  }

  return widgets;
}

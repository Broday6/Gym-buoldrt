export { CompassClient, debounceAsync } from './client.js';
export { ResultsWidget, SORT_OPTIONS, esc } from './results.js';
export { AutocompleteWidget } from './autocomplete.js';
export { FacetsWidget } from './facets.js';
export { RecommendWidget } from './recommend.js';

import { CompassClient } from './client.js';
import { ResultsWidget } from './results.js';
import { AutocompleteWidget } from './autocomplete.js';
import { FacetsWidget } from './facets.js';
import { RecommendWidget } from './recommend.js';

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
  // A caller may supply its own client. The widgets only ever call
  // `request(path, body)`, so anything satisfying that can drive them — a test
  // harness, or a self-contained page with no server to talk to.
  const client = options.client ?? new CompassClient(options);
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
        // Instant search: the grid follows the shopper's typing. Only meaningful
        // when there is a grid on the page to follow it.
        onInstant: widgets.results && options.instant !== false
          ? (value) => {
              if (value.length && value.length < (options.minChars ?? 2)) return;
              void widgets.results.setQuery(value);
            }
          : undefined,
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

  // Recommendation rails, each independently placed by the storefront.
  if (options.recommendations) {
    widgets.recommendations = options.recommendations.map((spec) =>
      new RecommendWidget({ ...options, client, ...spec }));
    for (const widget of widgets.recommendations) void widget.render();
  }

  // The shortcut every modern tool has. "/" alone is the storefront convention;
  // ⌘K is the one people bring from everywhere else.
  if (options.searchInput && options.shortcut !== false) {
    const input = typeof options.searchInput === 'string'
      ? document.querySelector(options.searchInput)
      : options.searchInput;
    document.addEventListener('keydown', (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
      const wants = ((event.metaKey || event.ctrlKey) && event.key === 'k') ||
        (event.key === '/' && !typing);
      if (!wants) return;
      event.preventDefault();
      input?.focus();
      input?.select();
    });
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

/** Shopper behaviour events. Append-only; the analytics + personalisation feed. */

export type EventType =
  | 'search'
  | 'click'
  | 'add_to_cart'
  | 'purchase'
  | 'product_view'
  | 'facet_apply'
  | 'zero_result';

export interface ShopperEvent {
  type: EventType;
  site: string;
  /** First-party cookie id. Anonymous. */
  shopperId: string;
  sessionId: string;
  timestamp?: string;
  query?: string;
  /** 1-based position of the clicked result. */
  position?: number;
  sku?: string;
  parentId?: string;
  categoryId?: string;
  filters?: Record<string, (string | number)[]>;
  resultCount?: number;
  /** Order value for purchase events, in site currency. */
  revenue?: number;
  quantity?: number;
  analyticsTags?: string[];
  /** Which rescue path saved a query that would otherwise have been empty. */
  rescueStrategy?: string;
  /** What the engine actually searched for, after synonyms and rescue. */
  effectiveQuery?: string;
  /** Set when the event happened under an A/B variant. */
  abTest?: { testId: string; variant: string };
}

export interface EventBatch {
  events: ShopperEvent[];
}

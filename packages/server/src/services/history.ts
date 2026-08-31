/**
 * Change history, and undo.
 *
 * Every merchandising write already recorded who changed what and when. What it
 * did not record was the *prior* state, which is the half that makes an undo
 * possible — so that was fixed first: a log that says "someone changed the
 * clearance rule" without saying what it was is a record of an accident, not a
 * way back from one.
 *
 * Revert is expressed as a new change rather than as a deletion of the old one.
 * The history stays append-only, an undo is itself auditable and itself
 * revertible, and there is never a moment where the log disagrees with the
 * state it describes.
 */
import type { Db } from '../db/pool.js';
import type { CollectionStore } from '../merchandising/collections.js';
import type { SynonymStore } from '../merchandising/synonyms.js';
import type { RedirectStore } from '../merchandising/redirects.js';

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface AuditEntry {
  id: number;
  siteId: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurredAt: string;
  /** Field-by-field, computed here so every client agrees on what changed. */
  changes?: FieldChange[];
  /** Whether this entry can be undone, and if not, why. */
  revertible: boolean;
  reason?: string;
}

/** Fields that describe when or where a row was written, not what it says. */
export const NOISE_FIELDS = [
  'id', 'siteId', 'createdAt', 'updatedAt', 'author', 'createdBy', 'products', 'reindexRequired',
];
const NOISE = new Set(NOISE_FIELDS);

/** What actually changed between two states, ignoring bookkeeping columns. */
export function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): FieldChange[] {
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: FieldChange[] = [];
  for (const field of fields) {
    if (NOISE.has(field)) continue;
    const a = before?.[field];
    const b = after?.[field];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    changes.push({ field, before: a ?? null, after: b ?? null });
  }
  return changes.sort((x, y) => x.field.localeCompare(y.field));
}

/** Entity types an undo knows how to put back. */
const REVERTIBLE = new Set(['collection', 'attribute', 'badge', 'synonym', 'redirect']);

export class HistoryService {
  constructor(
    private readonly db: Db,
    private readonly stores: {
      collections: CollectionStore;
      synonyms: SynonymStore;
      redirects: RedirectStore;
    },
  ) {}

  async list(siteId: string, limit = 100): Promise<AuditEntry[]> {
    const { rows } = await this.db.query<{
      id: string; site_id: string; actor: string; action: string; entity_type: string;
      entity_id: string | null; before: Record<string, unknown> | null;
      after: Record<string, unknown> | null; occurred_at: Date;
    }>(
      `SELECT id, site_id, actor, action, entity_type, entity_id, before, after, occurred_at
       FROM audit_log WHERE site_id = $1 ORDER BY id DESC LIMIT $2`,
      [siteId, Math.min(500, Math.max(1, limit))],
    );
    return rows.map((row) => {
      const entry: AuditEntry = {
        id: Number(row.id),
        siteId: row.site_id,
        actor: row.actor,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        before: row.before,
        after: row.after,
        occurredAt: row.occurred_at.toISOString(),
        revertible: true,
      };
      entry.changes = diff(entry.before, entry.after);
      const { ok, reason } = this.canRevert(entry);
      entry.revertible = ok;
      if (reason) entry.reason = reason;
      return entry;
    });
  }

  private canRevert(entry: AuditEntry): { ok: boolean; reason?: string } {
    if (!REVERTIBLE.has(entry.entityType)) {
      return { ok: false, reason: `${entry.entityType} changes cannot be undone automatically` };
    }
    if (!entry.entityId) return { ok: false, reason: 'no entity recorded' };
    if (!entry.before && !entry.after) {
      // Written before the log captured prior state. Honest about it rather
      // than offering a button that would delete something.
      return { ok: false, reason: 'this change predates full history and has no prior state' };
    }
    if ((entry.entityType === 'synonym' || entry.entityType === 'redirect') && entry.before) {
      return { ok: true, reason: 'restores the rule with a new id' };
    }
    return { ok: true };
  }

  /**
   * Undo one change, recording the undo as a change of its own.
   *
   * Two shapes: a change that created something is undone by removing it; a
   * change that modified or removed something is undone by writing the prior
   * state back.
   */
  async revert(siteId: string, id: number, actor: string): Promise<{
    reverted: AuditEntry; action: 'restored' | 'removed'; reindexRequired: boolean;
  }> {
    const [entry] = await this.list(siteId, 500).then((rows) => rows.filter((r) => r.id === id));
    if (!entry) throw new Error(`no history entry ${id} for this site`);
    const { ok, reason } = this.canRevert(entry);
    if (!ok) throw new Error(reason ?? 'this change cannot be undone');

    const action = entry.before ? 'restored' : 'removed';
    await (entry.before ? this.restore(entry) : this.remove(entry));

    await this.db.query(
      `INSERT INTO audit_log (site_id, actor, action, entity_type, entity_id, before, after)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      // Named `revert` flatly, not `revert:${entry.action}`: undoing an undo
      // would otherwise compound into `revert:revert:revert:upsert`, which is
      // technically accurate and unreadable. What was undone is the entry
      // directly below it, and the diff says what moved.
      [siteId, actor, 'revert', entry.entityType, entry.entityId,
       // The undo's own before/after are the reverse of the change it undoes,
       // so reverting the undo is the same operation again.
       entry.after ? JSON.stringify(entry.after) : null,
       entry.before ? JSON.stringify(entry.before) : null],
    );

    return {
      reverted: entry,
      action,
      // Collections, attributes and badges are baked into the index as labels.
      reindexRequired: ['collection', 'attribute', 'badge'].includes(entry.entityType),
    };
  }

  private async restore(entry: AuditEntry): Promise<void> {
    const state = entry.before as Record<string, unknown>;
    switch (entry.entityType) {
      case 'collection':
        await this.stores.collections.create(entry.siteId, state as never);
        return;
      case 'attribute':
        await this.stores.collections.createAttribute(entry.siteId, state as never);
        return;
      case 'badge':
        await this.stores.collections.createBadge(entry.siteId, state as never);
        return;
      case 'synonym':
        // Rules are keyed by a serial id, so a restored rule is a new row. Said
        // plainly in `reason` rather than pretending the id survived.
        await this.stores.synonyms.create(entry.siteId, state as never);
        return;
      case 'redirect':
        await this.stores.redirects.create(entry.siteId, state as never);
        return;
      default:
        throw new Error(`cannot restore a ${entry.entityType}`);
    }
  }

  private async remove(entry: AuditEntry): Promise<void> {
    const id = entry.entityId!;
    switch (entry.entityType) {
      case 'collection': await this.stores.collections.remove(entry.siteId, id); return;
      case 'attribute': await this.stores.collections.removeAttribute(entry.siteId, id); return;
      case 'badge': await this.stores.collections.removeBadge(entry.siteId, id); return;
      case 'synonym': await this.stores.synonyms.remove(entry.siteId, Number(id)); return;
      case 'redirect': await this.stores.redirects.remove(entry.siteId, Number(id)); return;
      default: throw new Error(`cannot remove a ${entry.entityType}`);
    }
  }
}

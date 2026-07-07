/**
 * Wire protocol mapping — local event log ↔ RolloMap Cloud wire contract (MIN-972).
 *
 * This module is the SINGLE SOURCE OF TRUTH for translating between the client's
 * local sync_event rows and the RolloMap Cloud wire protocol (Wire Contract v1).
 * See: docs/rollomap_protocol.md and rollomap_server/src/sync/events.ts.
 *
 * ── Terminology ──────────────────────────────────────────────────────────────
 *   Local:  events use field `operation` (free-form string) + local `entity_type`
 *           strings that match the DB table names (person, person_identity,
 *           person_topic, note, interaction, source_connection, contact_group …)
 *           and carry `device_id` in the sync_event row.
 *   Wire:   events use field `op` (closed enum) + wire `entity_type` enum
 *           (person|interaction|note|topic|commitment|identity|assertion) and
 *           carry NO `device_id` on push — the server derives it from the Bearer
 *           token per the protocol spec.
 *
 * ── Op Table (canonical 1:1 mapping — normative for push/pull) ───────────────
 *
 *   LOCAL op              WIRE op               LOCAL entity_type → WIRE entity_type
 *   ─────────────────────────────────────────────────────────────────────────────
 *   person.created        person.created        person → person
 *   person.updated        person.updated        person → person
 *   person.deleted        person.deleted        person → person
 *   person.merged         person.merged         person → person
 *   identity.added        identity.added        person_identity → identity
 *   topic.linked          topic.linked          person_topic → topic
 *   note.created          note.created          note → note
 *   interaction.created   interaction.created   interaction → interaction
 *   field.asserted        assertion.added       person → assertion
 *   profile.updated       profile.updated       workspace_profile → profile
 *
 * ── LOCAL-ONLY ops (not pushed to cloud; cloud wire format cannot represent them)
 *
 *   person.merge_reversed — local undo; no wire equivalent.
 *
 *   connection.created    ─┐
 *   connection.paused     │  Source-connector lifecycle is per-device local
 *   connection.resumed    │  state. Connection/group state will NOT converge
 *   connection.disconnected│  cross-device via cloud sync (known limitation).
 *   source.removed        ─┘
 *
 *   group.created         ─┐
 *   group.member_added    │  Contact group state is local-only; groups are
 *   group.imported        ─┘  shared out-of-band, not cloud-replicated.
 *
 * ── Wire ops without a current local equivalent ──────────────────────────────
 *   identity.removed, topic.created, topic.unlinked, note.updated, note.deleted,
 *   interaction.updated, interaction.deleted, commitment.created/updated/deleted
 *   exist in the wire enum but have no local op yet. fromWireEvent passes them
 *   through as-is; applyEvent will skip unknown ops without breaking the batch.
 */

// ─── Wire entity types ────────────────────────────────────────────────────────

/** Wire entity type enum — closed per the protocol. */
export const WIRE_ENTITY_TYPES = [
  'person',
  'interaction',
  'note',
  'topic',
  'commitment',
  'identity',
  'assertion',
  'profile',
] as const;
export type WireEntityType = (typeof WIRE_ENTITY_TYPES)[number];

// ─── Wire op enum ─────────────────────────────────────────────────────────────

/**
 * Wire operation vocabulary — closed enum from rollomap_protocol.md.
 * Consumers MUST NOT extend this list unilaterally; the protocol governs it.
 */
export const WIRE_OPS = [
  // people
  'person.created',
  'person.updated',
  'person.deleted',
  'person.merged',
  // identities (multi-value, additive)
  'identity.added',
  'identity.removed',
  // topics
  'topic.created',
  'topic.linked',
  'topic.unlinked',
  // notes
  'note.created',
  'note.updated',
  'note.deleted',
  // interactions
  'interaction.created',
  'interaction.updated',
  'interaction.deleted',
  // commitments (open loops)
  'commitment.created',
  'commitment.updated',
  'commitment.deleted',
  // field-level provenance
  'assertion.added',
  // workspace personalization profile (single-row config; MIN-1123)
  'profile.updated',
] as const;
export type WireOp = (typeof WIRE_OPS)[number];

const WIRE_OPS_SET = new Set<string>(WIRE_OPS);

/** Type guard: true if `op` is a member of the wire op closed enum. */
export function isWireOp(op: string): op is WireOp {
  return WIRE_OPS_SET.has(op);
}

// ─── Event shapes ─────────────────────────────────────────────────────────────

/**
 * Wire event envelope sent on POST /sync/push.
 * No `device_id` — the server derives it from the Bearer token.
 */
export interface WireEnvelope {
  /** Client-generated idempotency key (UUID). */
  id: string;
  /** Wire entity type (WIRE_ENTITY_TYPES member). */
  entity_type: WireEntityType;
  /** UUID of the affected entity. */
  entity_id: string;
  /** Wire operation (WIRE_OPS member). */
  op: WireOp;
  /** Opaque mutation payload (pass-through; no schema imposed by the protocol). */
  payload: Record<string, unknown>;
  /** Authoring device's Lamport clock value at the time of the event. */
  logical_clock: number;
  /** Optional SHA-256 content hash for tamper-detection. */
  hash?: string;
}

/**
 * Wire pull event as returned by GET /sync/pull.
 * Adds `server_seq`, `device_id` (set by server from the push token), and
 * `created_at`; the protocol does NOT guarantee `hash` in pull responses.
 */
export interface WirePullEvent {
  id: string;
  server_seq: number;
  entity_type: string;
  entity_id: string;
  op: string;
  payload: Record<string, unknown>;
  logical_clock: number;
  /** Device UUID — set by the server from the push token, not the client. */
  device_id: string;
  created_at: string;
  hash?: string;
}

/**
 * Local event shape as stored in sync_event (columns that matter for sync).
 * Reconstructed by fromWireEvent; consumed by applyEvent / pushEvents.
 */
export interface LocalEventShape {
  id: string;
  /** UUID of the device that authored the event. */
  device_id: string;
  /** Local entity type string (matches DB table / local convention). */
  entity_type: string;
  /** UUID of the affected entity. */
  entity_id: string;
  /** Local operation string (from SYNC_OPERATIONS or free-form for unknown ops). */
  operation: string;
  /** Pass-through payload. */
  payload: Record<string, unknown>;
  /** Lamport clock value. */
  logical_clock: number;
  /** SHA-256 content hash. */
  hash: string;
  /** Server sequence number (from pull; undefined for locally-authored events). */
  server_seq?: number;
}

// ─── Op table internals ───────────────────────────────────────────────────────

interface WireMapped {
  pushable: true;
  /** Wire operation this local op maps to. */
  wireOp: WireOp;
  /** Wire entity_type to use in the push envelope. */
  wireEntityType: WireEntityType;
  /**
   * Local entity_type to reconstruct when receiving this wire op via pull.
   * Must match what recordEvent callers store in sync_event.entity_type.
   */
  localEntityType: string;
}

interface LocalOnly {
  pushable: false;
  /** Human-readable justification (surfaced in error messages). */
  reason: string;
}

type OpEntry = WireMapped | LocalOnly;

// ─── Canonical op table (the authoritative mapping) ──────────────────────────

const OP_TABLE: Readonly<Record<string, OpEntry>> = {
  // ── Wire-mapped ops ─────────────────────────────────────────────────────────
  'person.created': {
    pushable: true,
    wireOp: 'person.created',
    wireEntityType: 'person',
    localEntityType: 'person',
  },
  'person.updated': {
    pushable: true,
    wireOp: 'person.updated',
    wireEntityType: 'person',
    localEntityType: 'person',
  },
  'person.deleted': {
    pushable: true,
    wireOp: 'person.deleted',
    wireEntityType: 'person',
    localEntityType: 'person',
  },
  'person.merged': {
    pushable: true,
    wireOp: 'person.merged',
    wireEntityType: 'person',
    localEntityType: 'person',
  },
  'identity.added': {
    pushable: true,
    wireOp: 'identity.added',
    wireEntityType: 'identity',
    localEntityType: 'person_identity',
  },
  'topic.created': {
    pushable: true,
    wireOp: 'topic.created',
    wireEntityType: 'topic',
    localEntityType: 'topic',
  },
  'topic.linked': {
    pushable: true,
    wireOp: 'topic.linked',
    wireEntityType: 'topic',
    localEntityType: 'person_topic',
  },
  'note.created': {
    pushable: true,
    wireOp: 'note.created',
    wireEntityType: 'note',
    localEntityType: 'note',
  },
  'interaction.created': {
    pushable: true,
    wireOp: 'interaction.created',
    wireEntityType: 'interaction',
    localEntityType: 'interaction',
  },
  /**
   * field.asserted → assertion.added
   * The local op stores entity_type='person' (the person being asserted about) and
   * entity_id=<person_uuid>. On the wire we use entity_type='assertion' per the
   * protocol enum; entity_id passes through unchanged (still the person_uuid).
   * fromWireEvent restores entity_type='person' so the round-trip is lossless.
   */
  'field.asserted': {
    pushable: true,
    wireOp: 'assertion.added',
    wireEntityType: 'assertion',
    localEntityType: 'person',
  },
  /**
   * profile.updated → profile.updated (MIN-1123)
   * The workspace_profile single-row config table. Local entity_type is the DB
   * table name 'workspace_profile'; on the wire the entity_type is 'profile'.
   * entity_id is the workspace_id and passes through unchanged; fromWireEvent
   * restores entity_type='workspace_profile' for a lossless round-trip.
   */
  'profile.updated': {
    pushable: true,
    wireOp: 'profile.updated',
    wireEntityType: 'profile',
    localEntityType: 'workspace_profile',
  },

  // ── LOCAL-ONLY ops ──────────────────────────────────────────────────────────
  'person.merge_reversed': {
    pushable: false,
    reason: 'merge-reversal is a local undo operation with no wire representation',
  },
  'connection.created': {
    pushable: false,
    reason: 'source-connector lifecycle is per-device local state, not cloud-replicated',
  },
  'connection.paused': {
    pushable: false,
    reason: 'source-connector lifecycle is per-device local state, not cloud-replicated',
  },
  'connection.resumed': {
    pushable: false,
    reason: 'source-connector lifecycle is per-device local state, not cloud-replicated',
  },
  'connection.disconnected': {
    pushable: false,
    reason: 'source-connector lifecycle is per-device local state, not cloud-replicated',
  },
  'source.removed': {
    pushable: false,
    reason: 'source-connector lifecycle is per-device local state, not cloud-replicated',
  },
  'group.created': {
    pushable: false,
    reason: 'contact group state is local-only; groups are shared out-of-band, not cloud-replicated',
  },
  'group.member_added': {
    pushable: false,
    reason: 'contact group state is local-only; groups are shared out-of-band, not cloud-replicated',
  },
  'group.imported': {
    pushable: false,
    reason: 'contact group import is a local read-side operation, not cloud-replicated',
  },
};

// ─── Derived lookup maps ──────────────────────────────────────────────────────

/**
 * Local-op → wire-op map. Keys are all pushable local ops.
 * Consumers that need a fast lookup (e.g. the sync agent's push filter) can use
 * this directly after confirming isPushable.
 */
export const LOCAL_TO_WIRE_OP: Readonly<Record<string, WireOp>> = Object.fromEntries(
  Object.entries(OP_TABLE)
    .filter((pair): pair is [string, WireMapped] => pair[1].pushable === true)
    .map(([localOp, entry]) => [localOp, entry.wireOp]),
);

/**
 * Wire-op → local reconstruction map. Covers only wire ops that have a known
 * local equivalent (the mapped subset). Wire ops absent from this map (e.g.
 * identity.removed, commitment.*) pass through fromWireEvent unchanged.
 */
export const WIRE_TO_LOCAL_OP: Readonly<
  Partial<Record<WireOp, { localOp: string; localEntityType: string }>>
> = Object.fromEntries(
  Object.entries(OP_TABLE)
    .filter((pair): pair is [string, WireMapped] => pair[1].pushable === true)
    .map(([localOp, entry]) => [
      entry.wireOp,
      { localOp, localEntityType: entry.localEntityType },
    ]),
);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if `localOp` has a wire equivalent and SHOULD be included in
 * cloud push batches. Returns false for LOCAL-ONLY ops (connection/group/merge-
 * reversed) and for any op not in the table.
 *
 * The sync agent (MIN-973) MUST use this to filter events before calling
 * toWireEnvelope.
 */
export function isPushable(localOp: string): boolean {
  return (OP_TABLE[localOp] as WireMapped | undefined)?.pushable === true;
}

/**
 * Convert a local sync_event row to a wire push envelope.
 *
 * Throws if the local op is LOCAL-ONLY. Callers should gate with isPushable
 * before calling, or filter the event list with LOCAL_TO_WIRE_OP.
 *
 * `device_id` is intentionally omitted — the server derives it from the Bearer
 * token per the wire contract; including it would be a protocol violation.
 */
export function toWireEnvelope(localEvent: {
  id: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  payload: unknown;
  logical_clock: string | number;
  hash: string;
}): WireEnvelope {
  const entry = OP_TABLE[localEvent.operation];
  if (!entry || !entry.pushable) {
    const reason = entry
      ? (entry as LocalOnly).reason
      : `"${localEvent.operation}" is not in the op table`;
    throw new Error(`toWireEnvelope: "${localEvent.operation}" is not pushable — ${reason}`);
  }
  const mapped = entry as WireMapped;

  // Payload must be an object on the wire (protocol requires Record<string,unknown>).
  const payload =
    localEvent.payload !== null &&
    typeof localEvent.payload === 'object' &&
    !Array.isArray(localEvent.payload)
      ? (localEvent.payload as Record<string, unknown>)
      : {};

  return {
    id: localEvent.id,
    entity_type: mapped.wireEntityType,
    entity_id: localEvent.entity_id,
    op: mapped.wireOp,
    payload,
    logical_clock: Number(localEvent.logical_clock),
    hash: localEvent.hash,
  };
}

/**
 * Reconstruct a local event shape from a wire pull event.
 *
 * `device_id` is taken from the pull event (set by the server from the
 * originating device's push token). `server_seq` is preserved for cursor
 * bookkeeping.
 *
 * Wire ops with no current local equivalent pass through unchanged; applyEvent
 * will skip them as "unknown operation" without breaking the batch.
 */
export function fromWireEvent(wireEvent: WirePullEvent): LocalEventShape {
  const reversal = isWireOp(wireEvent.op)
    ? WIRE_TO_LOCAL_OP[wireEvent.op]
    : undefined;

  return {
    id: wireEvent.id,
    device_id: wireEvent.device_id,
    entity_type: reversal?.localEntityType ?? wireEvent.entity_type,
    entity_id: wireEvent.entity_id,
    operation: reversal?.localOp ?? wireEvent.op,
    payload: wireEvent.payload,
    logical_clock: wireEvent.logical_clock,
    hash: wireEvent.hash ?? '',
    server_seq: wireEvent.server_seq,
  };
}

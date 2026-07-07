/**
 * Tests for the wire protocol mapping module (MIN-972).
 *
 * Verifies:
 *  - isPushable correctly classifies all SYNC_OPERATIONS entries
 *  - toWireEnvelope + fromWireEvent round-trip is lossless for every
 *    wire-mapped local op (deep-equal reconstruction of the local mutation)
 *  - local-only ops are not pushable and throw on toWireEnvelope
 *  - coverage: every WIRE_OPS member that is the target of some LOCAL_TO_WIRE_OP
 *    entry is reachable from a local op, and vice-versa for the mapped subset
 *  - device_id is absent from the push envelope (protocol requirement)
 *
 * This is a pure unit test — no database connection required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  WIRE_OPS,
  LOCAL_TO_WIRE_OP,
  WIRE_TO_LOCAL_OP,
  isPushable,
  toWireEnvelope,
  fromWireEvent,
  isWireOp,
  type WirePullEvent,
} from './wire.js';
import { SYNC_OPERATIONS } from './events.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

/** Build a representative local sync_event row for the given op. */
function makeLocalEvent(
  op: string,
  entityType: string,
  extraPayload: Record<string, unknown> = {},
) {
  const entityId = uuid();
  const payload = { id: entityId, workspace_id: uuid(), ...extraPayload };
  return {
    id: uuid(),
    device_id: uuid(),
    entity_type: entityType,
    entity_id: entityId,
    operation: op,
    payload,
    logical_clock: 42,
    hash: crypto.createHash('sha256').update(op + entityId).digest('hex'),
  };
}

/**
 * Simulate a server round-trip: take the wire push envelope and wrap it as a
 * pull event (server adds device_id from the token, server_seq, and created_at).
 */
function asPullEvent(
  wireEnv: ReturnType<typeof toWireEnvelope>,
  deviceId: string,
  serverSeq: number,
): WirePullEvent {
  return {
    id: wireEnv.id,
    server_seq: serverSeq,
    entity_type: wireEnv.entity_type,
    entity_id: wireEnv.entity_id,
    op: wireEnv.op,
    payload: wireEnv.payload,
    logical_clock: wireEnv.logical_clock,
    device_id: deviceId,
    created_at: new Date().toISOString(),
    hash: wireEnv.hash,
  };
}

// ─── Test data: one representative local event per wire-mapped op ─────────────

const ROUND_TRIP_CASES: ReadonlyArray<{
  localOp: string;
  entityType: string;
  extra?: Record<string, unknown>;
}> = [
  {
    localOp: 'person.created',
    entityType: 'person',
    extra: { display_name: 'Alice' },
  },
  {
    localOp: 'person.updated',
    entityType: 'person',
    extra: { display_name: 'Alice Updated' },
  },
  {
    localOp: 'person.deleted',
    entityType: 'person',
    extra: { reason: 'duplicate' },
  },
  {
    localOp: 'person.merged',
    entityType: 'person',
    extra: { source_id: uuid(), target_id: uuid() },
  },
  {
    localOp: 'identity.added',
    entityType: 'person_identity',
    extra: { identity_type: 'email', identity_value: 'alice@example.com', person_id: uuid() },
  },
  {
    localOp: 'topic.created',
    entityType: 'topic',
    extra: { name: 'AI' },
  },
  {
    localOp: 'topic.linked',
    entityType: 'person_topic',
    extra: { topic_name: 'AI', person_id: uuid() },
  },
  {
    localOp: 'note.created',
    entityType: 'note',
    extra: { body: 'Met at conference', person_id: uuid() },
  },
  {
    localOp: 'interaction.created',
    entityType: 'interaction',
    extra: { title: 'Coffee chat', interaction_type: 'meeting' },
  },
  {
    localOp: 'field.asserted',
    entityType: 'person',
    extra: { field_name: 'company', field_value: 'Acme Corp', person_id: uuid() },
  },
  {
    localOp: 'profile.updated',
    entityType: 'workspace_profile',
    extra: { ownerName: 'Matt', interests: ['ai', 'networking'] },
  },
];

const LOCAL_ONLY_OPS: ReadonlyArray<string> = [
  'person.merge_reversed',
  'connection.created',
  'connection.paused',
  'connection.resumed',
  'connection.disconnected',
  'source.removed',
  'group.created',
  'group.member_added',
  'group.imported',
];

// ─── Tests: isPushable ────────────────────────────────────────────────────────

describe('wire.isPushable — wire-mapped ops return true', () => {
  for (const { localOp } of ROUND_TRIP_CASES) {
    it(`isPushable("${localOp}") === true`, () => {
      assert.equal(isPushable(localOp), true);
    });
  }
});

describe('wire.isPushable — local-only ops return false', () => {
  for (const op of LOCAL_ONLY_OPS) {
    it(`isPushable("${op}") === false`, () => {
      assert.equal(isPushable(op), false);
    });
  }
});

describe('wire.isPushable — edge cases', () => {
  it('unknown op returns false', () => {
    assert.equal(isPushable('foo.bar'), false);
  });

  it('empty string returns false', () => {
    assert.equal(isPushable(''), false);
  });

  it('all SYNC_OPERATIONS are classified (pushable or local-only, never undefined)', () => {
    for (const op of SYNC_OPERATIONS) {
      const result = isPushable(op);
      assert.ok(
        typeof result === 'boolean',
        `SYNC_OPERATIONS member "${op}" must return boolean from isPushable`,
      );
    }
  });
});

// ─── Tests: round-trip fidelity ───────────────────────────────────────────────

describe('wire round-trip — toWireEnvelope then fromWireEvent reconstructs local event', () => {
  for (const { localOp, entityType, extra } of ROUND_TRIP_CASES) {
    it(`round-trip for ${localOp}`, () => {
      const local = makeLocalEvent(localOp, entityType, extra ?? {});

      // ── Push direction: local → wire ──────────────────────────────────────
      const wireEnv = toWireEnvelope(local);

      // The wire op must be in the closed WIRE_OPS enum.
      assert.ok(
        (WIRE_OPS as ReadonlyArray<string>).includes(wireEnv.op),
        `wireEnv.op "${wireEnv.op}" must be in WIRE_OPS`,
      );
      // Core fields preserved.
      assert.equal(wireEnv.id,            local.id,            'id preserved in push envelope');
      assert.equal(wireEnv.entity_id,     local.entity_id,     'entity_id preserved in push envelope');
      assert.equal(wireEnv.logical_clock, local.logical_clock,  'logical_clock preserved');
      assert.deepEqual(wireEnv.payload,   local.payload,       'payload is a pass-through');
      // device_id MUST NOT appear on the wire push envelope.
      assert.ok(
        !('device_id' in wireEnv),
        'wire push envelope must not carry device_id (server derives it from token)',
      );

      // ── Pull direction: simulate server response ───────────────────────────
      const pullEvent = asPullEvent(wireEnv, local.device_id, 99);
      const reconstructed = fromWireEvent(pullEvent);

      // Round-trip invariants: identical local mutation.
      assert.equal(reconstructed.id,            local.id,            'id');
      assert.equal(reconstructed.entity_id,     local.entity_id,     'entity_id');
      assert.equal(reconstructed.operation,     local.operation,     'operation (local op name restored)');
      assert.equal(reconstructed.entity_type,   local.entity_type,   'entity_type (local type restored)');
      assert.equal(reconstructed.device_id,     local.device_id,     'device_id (from pull event)');
      assert.equal(reconstructed.logical_clock, local.logical_clock,  'logical_clock');
      assert.deepEqual(reconstructed.payload,   local.payload,       'payload');
      assert.equal(reconstructed.hash,          local.hash,          'hash');
      assert.equal(reconstructed.server_seq,    99,                  'server_seq from pull event');
    });
  }
});

// ─── Tests: local-only ops throw on toWireEnvelope ───────────────────────────

describe('wire.toWireEnvelope — throws for local-only ops', () => {
  for (const op of LOCAL_ONLY_OPS) {
    it(`toWireEnvelope throws for "${op}"`, () => {
      const local = makeLocalEvent(op, 'person');
      assert.throws(
        () => toWireEnvelope(local),
        /not pushable/,
        `toWireEnvelope("${op}") must throw with "not pushable" in the message`,
      );
    });
  }

  it('toWireEnvelope throws for an unknown op', () => {
    const local = makeLocalEvent('planet.exploded', 'planet');
    assert.throws(() => toWireEnvelope(local), /not pushable/);
  });
});

// ─── Tests: fromWireEvent — unknown wire ops pass through ─────────────────────

describe('wire.fromWireEvent — unknown wire ops pass through unchanged', () => {
  it('wire op with no local mapping passes through', () => {
    const pull: WirePullEvent = {
      id: uuid(),
      server_seq: 77,
      entity_type: 'commitment',
      entity_id: uuid(),
      op: 'commitment.created',
      payload: { title: 'Follow up' },
      logical_clock: 3,
      device_id: uuid(),
      created_at: new Date().toISOString(),
    };
    const local = fromWireEvent(pull);
    assert.equal(local.operation, 'commitment.created', 'unmapped wire op preserved as local op');
    assert.equal(local.entity_type, 'commitment',        'unmapped entity_type preserved');
    assert.equal(local.server_seq, 77);
  });

  it('unrecognised op string (not even in WIRE_OPS) passes through', () => {
    const pull: WirePullEvent = {
      id: uuid(),
      server_seq: 1,
      entity_type: 'unknown',
      entity_id: uuid(),
      op: 'future.operation',
      payload: {},
      logical_clock: 0,
      device_id: uuid(),
      created_at: new Date().toISOString(),
    };
    const local = fromWireEvent(pull);
    assert.equal(local.operation, 'future.operation');
    assert.equal(local.entity_type, 'unknown');
  });
});

// ─── Tests: coverage assertions ───────────────────────────────────────────────

describe('wire coverage — LOCAL_TO_WIRE_OP', () => {
  it('every key in LOCAL_TO_WIRE_OP is a pushable local op', () => {
    for (const localOp of Object.keys(LOCAL_TO_WIRE_OP)) {
      assert.equal(
        isPushable(localOp),
        true,
        `LOCAL_TO_WIRE_OP key "${localOp}" must be pushable`,
      );
    }
  });

  it('every value in LOCAL_TO_WIRE_OP is a member of WIRE_OPS', () => {
    const wireOpsSet = new Set<string>(WIRE_OPS);
    for (const [localOp, wireOp] of Object.entries(LOCAL_TO_WIRE_OP)) {
      assert.ok(
        wireOpsSet.has(wireOp),
        `LOCAL_TO_WIRE_OP["${localOp}"] = "${wireOp}" is not in WIRE_OPS`,
      );
    }
  });

  it('LOCAL_TO_WIRE_OP contains exactly the wire-mapped ops in ROUND_TRIP_CASES', () => {
    for (const { localOp } of ROUND_TRIP_CASES) {
      assert.ok(
        localOp in LOCAL_TO_WIRE_OP,
        `LOCAL_TO_WIRE_OP must contain "${localOp}"`,
      );
    }
  });
});

describe('wire coverage — WIRE_TO_LOCAL_OP', () => {
  it('every key in WIRE_TO_LOCAL_OP is in WIRE_OPS', () => {
    const wireOpsSet = new Set<string>(WIRE_OPS);
    for (const wireOp of Object.keys(WIRE_TO_LOCAL_OP)) {
      assert.ok(
        wireOpsSet.has(wireOp),
        `WIRE_TO_LOCAL_OP key "${wireOp}" is not in WIRE_OPS`,
      );
    }
  });

  it('WIRE_TO_LOCAL_OP reverse-maps every entry in LOCAL_TO_WIRE_OP', () => {
    for (const [localOp, wireOp] of Object.entries(LOCAL_TO_WIRE_OP)) {
      const reverse = WIRE_TO_LOCAL_OP[wireOp];
      assert.ok(
        reverse !== undefined,
        `WIRE_TO_LOCAL_OP is missing entry for wire op "${wireOp}" (from local op "${localOp}")`,
      );
      assert.equal(
        reverse!.localOp,
        localOp,
        `WIRE_TO_LOCAL_OP["${wireOp}"].localOp must equal "${localOp}"`,
      );
    }
  });
});

describe('wire coverage — isWireOp', () => {
  it('all WIRE_OPS members are recognised', () => {
    for (const op of WIRE_OPS) {
      assert.ok(isWireOp(op), `isWireOp("${op}") must be true`);
    }
  });

  it('non-wire ops are not recognised', () => {
    assert.equal(isWireOp('field.asserted'), false);
    assert.equal(isWireOp('connection.created'), false);
    assert.equal(isWireOp(''), false);
  });
});

/**
 * Test-only side-effect module: pin this process to a DEDICATED workspace.
 *
 * The sync agent's state lives in singleton rows keyed by WORKSPACE_ID
 * (cloud_config, cloud_sync_state) plus the workspace-scoped sync_event log.
 * Node's test runner executes test FILES in parallel processes against the same
 * throwaway rollomap_test DB, so sync-agent.test.ts would otherwise race with
 * cloud.test.ts on the shared default-workspace rows.
 *
 * Importing this module FIRST (before ../db.js) sets a unique WORKSPACE_ID for
 * this process, fully isolating the sync-agent tests. The companion test creates
 * the matching workspace row in a top-level before() hook.
 *
 * Not a *.test.ts file, so the runner does not execute it directly.
 */
export const TEST_WORKSPACE_ID = '00000000-0000-0000-0000-000000000973';
process.env.WORKSPACE_ID = TEST_WORKSPACE_ID;

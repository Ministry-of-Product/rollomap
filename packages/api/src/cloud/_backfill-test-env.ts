/**
 * Test-only side-effect module: pin this process to a dedicated workspace.
 * Import FIRST (before ../db.js) so the WORKSPACE_ID singleton is set correctly.
 */
export const TEST_WORKSPACE_ID = '00000000-0000-0000-0000-000000000975';
process.env.WORKSPACE_ID = TEST_WORKSPACE_ID;

import { Router } from 'express';
import { z } from 'zod';
import { getProfile, updateProfile, type WorkspaceProfilePatch } from '../profile/store.js';

export const profileRouter = Router();

profileRouter.get('/', async (_req, res) => {
  res.json({ profile: await getProfile() });
});

profileRouter.put('/', async (req, res) => {
  const Body = z.object({
    owner_name: z.string().nullable().optional(),
    owner_emails: z.array(z.string()).optional(),
    owner_aliases: z.array(z.string()).optional(),
    interests: z.array(z.string()).optional(),
    primary_network: z.string().nullable().optional(),
    import_recipes: z.array(z.record(z.unknown())).optional(),
    journal_skip_phrases: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
  });
  const data = Body.parse(req.body);
  // Forward ONLY the keys the caller actually provided, so updateProfile can
  // distinguish explicit-null (clear owner_name/primary_network) from omitted
  // (keep existing). zod drops absent optional keys, so `... in data` is honest.
  const patch: WorkspaceProfilePatch = {};
  if ('owner_name' in data) patch.ownerName = data.owner_name;
  if ('owner_emails' in data) patch.ownerEmails = data.owner_emails;
  if ('owner_aliases' in data) patch.ownerAliases = data.owner_aliases;
  if ('interests' in data) patch.interests = data.interests;
  if ('primary_network' in data) patch.primaryNetwork = data.primary_network;
  if ('import_recipes' in data) patch.importRecipes = data.import_recipes;
  if ('journal_skip_phrases' in data) patch.journalSkipPhrases = data.journal_skip_phrases;
  if ('metadata' in data) patch.metadata = data.metadata;
  const profile = await updateProfile(patch);
  res.json({ profile });
});

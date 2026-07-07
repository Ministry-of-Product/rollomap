import { Router } from 'express';
import { z } from 'zod';
import { getProfile, updateProfile } from '../profile/store.js';

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
  const profile = await updateProfile({
    ownerName: data.owner_name,
    ownerEmails: data.owner_emails,
    ownerAliases: data.owner_aliases,
    interests: data.interests,
    primaryNetwork: data.primary_network,
    importRecipes: data.import_recipes,
    journalSkipPhrases: data.journal_skip_phrases,
    metadata: data.metadata,
  });
  res.json({ profile });
});

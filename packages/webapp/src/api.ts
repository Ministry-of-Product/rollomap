const base = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export type Person = {
  id: string;
  display_name: string;
  primary_email: string | null;
  company: string | null;
  title: string | null;
  summary: string | null;
  how_known: string | null;
  linkedin_url: string | null;
  aliases: string[];
  known_emails: string[];
  known_phones: string[];
  last_seen_at: string | null;
  first_seen_at: string | null;
  interaction_count: number;
  relationship_strength: string | number;
  confidence: string | number;
  user_pinned: boolean;
  topics?: { id: string; name: string; confidence: number }[];
};

export type Interaction = {
  id: string;
  interaction_type: string;
  title: string | null;
  summary: string | null;
  body: string | null;
  occurred_at: string;
  topics: string[];
  participants?: { id: string; display_name: string }[];
};

export type Topic = {
  id: string;
  name: string;
  description: string | null;
  person_count?: number;
};

export type Note = {
  id: string;
  person_id: string | null;
  body: string;
  created_at: string;
};

export type Commitment = {
  id: string;
  person_id: string | null;
  person_name: string | null;
  description: string;
  status: 'open' | 'done' | 'dismissed';
  due_date: string | null;
  created_at: string;
};

export type SourceItem = {
  id: string;
  provider: string;
  source_type: string;
  title: string | null;
  author: string | null;
  participants: string[];
  created_at_source: string | null;
  ingested_at: string;
  body_length: number;
};

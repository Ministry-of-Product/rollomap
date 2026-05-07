import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Interaction, Person } from '../api';

export function InteractionsPage() {
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [form, setForm] = useState({
    interaction_type: 'meeting',
    title: '',
    summary: '',
    occurred_at: new Date().toISOString().slice(0, 16),
    participant_ids: [] as string[],
  });

  const load = async (query?: string) => {
    const res = await api.get<{ interactions: Interaction[] }>(`/interactions${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    setInteractions(res.interactions);
  };
  useEffect(() => { load(); api.get<{ people: Person[] }>('/people').then(r => setPeople(r.people)); }, []);

  const onSearch = (e: React.FormEvent) => { e.preventDefault(); load(q); };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.post('/interactions', {
      ...form,
      occurred_at: new Date(form.occurred_at).toISOString(),
    });
    setForm({ interaction_type: 'meeting', title: '', summary: '', occurred_at: new Date().toISOString().slice(0, 16), participant_ids: [] });
    setCreating(false);
    load(q);
  };

  return (
    <div>
      <div className="row between">
        <h2>Interactions</h2>
        <button className="btn" onClick={() => setCreating(c => !c)}>{creating ? 'Cancel' : 'Log interaction'}</button>
      </div>

      {creating && (
        <form className="card" onSubmit={onCreate}>
          <div className="grid cols-2">
            <div>
              <label>Type</label>
              <select value={form.interaction_type} onChange={e => setForm({ ...form, interaction_type: e.target.value })} style={{ width: '100%' }}>
                <option value="meeting">Meeting</option>
                <option value="email">Email</option>
                <option value="call">Call</option>
                <option value="meeting_note">Meeting note</option>
                <option value="note">Note</option>
                <option value="introduction">Introduction</option>
              </select>
            </div>
            <div>
              <label>When</label>
              <input type="datetime-local" value={form.occurred_at} onChange={e => setForm({ ...form, occurred_at: e.target.value })} style={{ width: '100%' }} />
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label>Title</label>
            <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} style={{ width: '100%' }} />
          </div>
          <div style={{ marginTop: 8 }}>
            <label>Summary</label>
            <textarea value={form.summary} onChange={e => setForm({ ...form, summary: e.target.value })} />
          </div>
          <div style={{ marginTop: 8 }}>
            <label>Participants (cmd-click to multi-select)</label>
            <select
              multiple
              value={form.participant_ids}
              onChange={e => setForm({
                ...form,
                participant_ids: Array.from(e.target.selectedOptions).map(o => o.value),
              })}
              style={{ width: '100%', minHeight: 120 }}
            >
              {people.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
            </select>
          </div>
          <div style={{ marginTop: 12 }}><button className="btn" type="submit">Save</button></div>
        </form>
      )}

      <form onSubmit={onSearch} style={{ margin: '12px 0' }}>
        <input className="searchbar" value={q} onChange={e => setQ(e.target.value)} placeholder="Search interactions…" />
      </form>

      {interactions.length === 0 ? (
        <div className="empty">No interactions yet.</div>
      ) : interactions.map(i => (
        <div key={i.id} className="card">
          <div className="row between">
            <strong>{i.title || i.interaction_type}</strong>
            <span className="tag">{i.interaction_type}</span>
          </div>
          <div className="meta">{new Date(i.occurred_at).toLocaleString()}</div>
          <p>{i.summary}</p>
          <div>
            {(i.participants ?? []).map(p => (
              <Link key={p.id} to={`/people/${p.id}`} className="tag">{p.display_name}</Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Person } from '../api';

export function PeoplePage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newCompany, setNewCompany] = useState('');

  const load = async (query?: string) => {
    setLoading(true);
    const params = query ? `?q=${encodeURIComponent(query)}` : '';
    const res = await api.get<{ people: Person[] }>(`/people${params}`);
    setPeople(res.people);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onSearch = (e: React.FormEvent) => { e.preventDefault(); load(q); };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    await api.post('/people', {
      display_name: newName.trim(),
      primary_email: newEmail.trim() || undefined,
      company: newCompany.trim() || undefined,
    });
    setNewName(''); setNewEmail(''); setNewCompany('');
    setCreating(false);
    load(q);
  };

  return (
    <div>
      <div className="row between">
        <h2>People</h2>
        <button className="btn" onClick={() => setCreating(c => !c)}>{creating ? 'Cancel' : 'Add person'}</button>
      </div>

      {creating && (
        <form className="card" onSubmit={onCreate}>
          <div className="grid cols-2">
            <div>
              <label>Name</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} required style={{ width: '100%' }} />
            </div>
            <div>
              <label>Email</label>
              <input value={newEmail} onChange={e => setNewEmail(e.target.value)} type="email" style={{ width: '100%' }} />
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label>Company</label>
            <input value={newCompany} onChange={e => setNewCompany(e.target.value)} style={{ width: '100%' }} />
          </div>
          <div style={{ marginTop: 12 }}>
            <button className="btn" type="submit">Save</button>
          </div>
        </form>
      )}

      <form onSubmit={onSearch} style={{ margin: '12px 0' }}>
        <input
          className="searchbar"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search people by name, email, company, summary…"
        />
      </form>

      {loading ? (
        <div className="empty">Loading…</div>
      ) : people.length === 0 ? (
        <div className="empty">No people found.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Company / Title</th>
              <th>Topics</th>
              <th>Last seen</th>
              <th>Strength</th>
            </tr>
          </thead>
          <tbody>
            {people.map(p => (
              <tr key={p.id}>
                <td>
                  <Link to={`/people/${p.id}`}>{p.display_name}</Link>
                  <div className="meta">{p.primary_email}</div>
                </td>
                <td>{[p.company, p.title].filter(Boolean).join(' · ') || <span className="meta">—</span>}</td>
                <td>
                  {(p.topics ?? []).slice(0, 4).map(t => (
                    <span key={t.id} className="tag">{t.name}</span>
                  ))}
                </td>
                <td className="meta">{p.last_seen_at ? new Date(p.last_seen_at).toLocaleDateString() : '—'}</td>
                <td>{Number(p.relationship_strength).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

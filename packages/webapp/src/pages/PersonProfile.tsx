import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, Commitment, Interaction, Note, Person } from '../api';

type Detail = {
  person: Person;
  topics: { id: string; name: string; confidence: number; user_confirmed: boolean; last_evidence_at: string | null }[];
  interactions: Interaction[];
  notes: Note[];
  commitments: Commitment[];
  identities: { id: string; identity_type: string; identity_value: string; confidence: number }[];
};

export function PersonProfilePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<Detail | null>(null);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ display_name: '', company: '', title: '', summary: '', how_known: '' });
  const [newNote, setNewNote] = useState('');
  const [newTopic, setNewTopic] = useState('');

  const load = async () => {
    if (!id) return;
    const res = await api.get<Detail>(`/people/${id}`);
    setData(res);
    setEdit({
      display_name: res.person.display_name,
      company: res.person.company ?? '',
      title: res.person.title ?? '',
      summary: res.person.summary ?? '',
      how_known: res.person.how_known ?? '',
    });
  };

  useEffect(() => { load(); }, [id]);

  if (!data) return <div className="empty">Loading…</div>;
  const { person, topics, interactions, notes, commitments } = data;

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.patch(`/people/${id}`, {
      display_name: edit.display_name,
      company: edit.company || null,
      title: edit.title || null,
      summary: edit.summary || null,
      how_known: edit.how_known || null,
    });
    setEditing(false);
    load();
  };

  const onAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNote.trim()) return;
    await api.post('/notes', { person_id: id, body: newNote.trim() });
    setNewNote('');
    load();
  };

  const onAddTopic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTopic.trim()) return;
    await api.post(`/people/${id}/topics`, { topic_name: newTopic.trim(), user_confirmed: true, confidence: 0.95 });
    setNewTopic('');
    load();
  };

  const onRemoveTopic = async (topicId: string) => {
    await api.del(`/people/${id}/topics/${topicId}`);
    load();
  };

  const onDeletePerson = async () => {
    if (!confirm(`Delete ${person.display_name}? This will remove all interactions, notes, and topic links.`)) return;
    await api.del(`/people/${id}`);
    navigate('/people');
  };

  return (
    <div>
      <div className="row between">
        <div>
          <Link to="/people" className="meta">← People</Link>
          <h2 style={{ margin: '4px 0 0' }}>{person.display_name}</h2>
          <div className="meta">{[person.title, person.company].filter(Boolean).join(' · ')}</div>
          {person.primary_email && <div className="meta">{person.primary_email}</div>}
        </div>
        <div className="row">
          <button className="btn secondary" onClick={() => setEditing(e => !e)}>{editing ? 'Cancel' : 'Edit'}</button>
          <button className="btn danger" onClick={onDeletePerson}>Delete</button>
        </div>
      </div>

      {editing ? (
        <form className="card" onSubmit={onSave}>
          <div className="grid cols-2">
            <div><label>Name</label><input value={edit.display_name} onChange={e => setEdit({ ...edit, display_name: e.target.value })} style={{ width: '100%' }} /></div>
            <div><label>Email</label><input value={person.primary_email ?? ''} disabled style={{ width: '100%' }} /></div>
            <div><label>Company</label><input value={edit.company} onChange={e => setEdit({ ...edit, company: e.target.value })} style={{ width: '100%' }} /></div>
            <div><label>Title</label><input value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} style={{ width: '100%' }} /></div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label>How I know them</label>
            <textarea value={edit.how_known} onChange={e => setEdit({ ...edit, how_known: e.target.value })} />
          </div>
          <div style={{ marginTop: 8 }}>
            <label>Summary</label>
            <textarea value={edit.summary} onChange={e => setEdit({ ...edit, summary: e.target.value })} />
          </div>
          <div style={{ marginTop: 12 }}>
            <button type="submit" className="btn">Save</button>
          </div>
        </form>
      ) : (
        <div className="card">
          <h3>Summary</h3>
          <p>{person.summary || <span className="meta">No summary yet.</span>}</p>
          <h3 style={{ marginTop: 16 }}>How I know them</h3>
          <p>{person.how_known || <span className="meta">No context yet.</span>}</p>
          <div className="row" style={{ marginTop: 16, gap: 24 }}>
            <div className="meta">
              <div>First seen</div>
              <div style={{ color: 'var(--text)' }}>{person.first_seen_at ? new Date(person.first_seen_at).toLocaleDateString() : '—'}</div>
            </div>
            <div className="meta">
              <div>Last seen</div>
              <div style={{ color: 'var(--text)' }}>{person.last_seen_at ? new Date(person.last_seen_at).toLocaleDateString() : '—'}</div>
            </div>
            <div className="meta">
              <div>Interactions</div>
              <div style={{ color: 'var(--text)' }}>{person.interaction_count}</div>
            </div>
            <div className="meta">
              <div>Strength</div>
              <div style={{ color: 'var(--text)' }}>{Number(person.relationship_strength).toFixed(2)}</div>
            </div>
          </div>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <h3>Topics</h3>
          {topics.length === 0 ? <div className="empty" style={{ padding: 8 }}>No topics yet.</div> : (
            <div>
              {topics.map(t => (
                <span key={t.id} className={`tag ${t.user_confirmed ? 'confirmed' : ''}`} style={{ marginBottom: 6 }}>
                  {t.name} <small className="meta">{Number(t.confidence).toFixed(2)}</small>
                  <button className="btn small secondary" style={{ marginLeft: 6 }} onClick={() => onRemoveTopic(t.id)}>×</button>
                </span>
              ))}
            </div>
          )}
          <form onSubmit={onAddTopic} style={{ marginTop: 12 }} className="row">
            <input value={newTopic} onChange={e => setNewTopic(e.target.value)} placeholder="Add topic (e.g. AI agents)" style={{ flex: 1 }} />
            <button className="btn small" type="submit">Add</button>
          </form>
        </div>

        <div className="card">
          <h3>Open loops</h3>
          {commitments.filter(c => c.status === 'open').length === 0 ? (
            <div className="empty" style={{ padding: 8 }}>None.</div>
          ) : (
            commitments.filter(c => c.status === 'open').map(c => (
              <div key={c.id} className="timeline-item">
                <div>{c.description}</div>
                <div className="when">{c.due_date ? `Due ${new Date(c.due_date).toLocaleDateString()}` : 'No due date'}</div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card">
        <h3>Notes</h3>
        <form onSubmit={onAddNote} style={{ marginBottom: 12 }}>
          <textarea value={newNote} onChange={e => setNewNote(e.target.value)} placeholder="Add a note about this person…" />
          <div style={{ marginTop: 6 }}><button className="btn small" type="submit">Add note</button></div>
        </form>
        {notes.length === 0 ? <div className="empty" style={{ padding: 8 }}>No notes.</div> : notes.map(n => (
          <div key={n.id} className="timeline-item">
            <div>{n.body}</div>
            <div className="when">{new Date(n.created_at).toLocaleString()}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Interactions</h3>
        {interactions.length === 0 ? <div className="empty" style={{ padding: 8 }}>No interactions.</div> : interactions.map(i => (
          <div key={i.id} className="timeline-item">
            <div className="row between">
              <strong>{i.title || i.interaction_type}</strong>
              <span className="tag">{i.interaction_type}</span>
            </div>
            <div>{i.summary}</div>
            <div className="when">{new Date(i.occurred_at).toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

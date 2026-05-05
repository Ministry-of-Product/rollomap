import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Topic } from '../api';

export function TopicsPage() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const load = async () => {
    const res = await api.get<{ topics: Topic[] }>('/topics');
    setTopics(res.topics);
  };
  useEffect(() => { load(); }, []);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api.post('/topics', { name: name.trim(), description: description.trim() || undefined });
      setName(''); setDescription('');
      load();
    } catch (err) {
      alert(String(err));
    }
  };

  return (
    <div>
      <h2>Topics</h2>
      <form className="card" onSubmit={onCreate}>
        <div className="grid cols-2">
          <div>
            <label>New topic name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="AI agents, proptech…" style={{ width: '100%' }} />
          </div>
          <div>
            <label>Description (optional)</label>
            <input value={description} onChange={e => setDescription(e.target.value)} style={{ width: '100%' }} />
          </div>
        </div>
        <div style={{ marginTop: 12 }}><button type="submit" className="btn">Add topic</button></div>
      </form>

      {topics.length === 0 ? <div className="empty">No topics yet.</div> : (
        <table>
          <thead><tr><th>Topic</th><th>Description</th><th>People</th></tr></thead>
          <tbody>
            {topics.map(t => (
              <tr key={t.id}>
                <td><Link to={`/topics/${t.id}`}>{t.name}</Link></td>
                <td className="meta">{t.description || '—'}</td>
                <td>{t.person_count ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

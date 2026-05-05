import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Neglected = {
  id: string;
  display_name: string;
  company: string | null;
  title: string | null;
  last_seen_at: string | null;
  relationship_strength: number;
  interaction_count: number;
};

export function ReviewPage() {
  const [neglected, setNeglected] = useState<Neglected[]>([]);
  const [days, setDays] = useState(90);

  const load = async () => {
    const res = await api.get<{ people: Neglected[] }>(`/query/neglected?days=${days}`);
    setNeglected(res.people);
  };
  useEffect(() => { load(); }, [days]);

  return (
    <div>
      <h2>Review</h2>
      <p className="meta">Surfaces relationships that may need attention. RolloMap suggests; you decide.</p>

      <div className="card">
        <div className="row between">
          <h3>Neglected relationships</h3>
          <div className="row">
            <label style={{ margin: 0 }}>Inactive for</label>
            <select value={days} onChange={e => setDays(Number(e.target.value))}>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={365}>1 year</option>
            </select>
          </div>
        </div>
        {neglected.length === 0 ? <div className="empty" style={{ padding: 16 }}>No neglected contacts found.</div> : (
          <table>
            <thead><tr><th>Person</th><th>Company</th><th>Last seen</th><th>Strength</th></tr></thead>
            <tbody>
              {neglected.map(p => (
                <tr key={p.id}>
                  <td><Link to={`/people/${p.id}`}>{p.display_name}</Link></td>
                  <td>{[p.company, p.title].filter(Boolean).join(' · ') || <span className="meta">—</span>}</td>
                  <td className="meta">{p.last_seen_at ? new Date(p.last_seen_at).toLocaleDateString() : 'never'}</td>
                  <td>{Number(p.relationship_strength).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

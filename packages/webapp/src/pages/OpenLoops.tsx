import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Commitment } from '../api';

export function OpenLoopsPage() {
  const [items, setItems] = useState<Commitment[]>([]);
  const [filter, setFilter] = useState<'open' | 'all'>('open');

  const load = async () => {
    const path = filter === 'open' ? '/commitments?status=open' : '/commitments';
    const res = await api.get<{ commitments: Commitment[] }>(path);
    setItems(res.commitments);
  };
  useEffect(() => { load(); }, [filter]);

  const setStatus = async (id: string, status: 'open' | 'done' | 'dismissed') => {
    await api.patch(`/commitments/${id}`, { status });
    load();
  };

  return (
    <div>
      <div className="row between">
        <h2>Open loops</h2>
        <select value={filter} onChange={e => setFilter(e.target.value as 'open' | 'all')}>
          <option value="open">Open only</option>
          <option value="all">All</option>
        </select>
      </div>
      {items.length === 0 ? <div className="empty">Nothing pending.</div> : items.map(c => (
        <div key={c.id} className="card">
          <div className="row between">
            <div>
              <strong>{c.description}</strong>
              <div className="meta">
                {c.person_name && <Link to={`/people/${c.person_id}`}>{c.person_name}</Link>}
                {c.due_date && <> · due {new Date(c.due_date).toLocaleDateString()}</>}
                {' · '}{c.status}
              </div>
            </div>
            <div className="row">
              {c.status === 'open' && (
                <>
                  <button className="btn small" onClick={() => setStatus(c.id, 'done')}>Mark done</button>
                  <button className="btn small secondary" onClick={() => setStatus(c.id, 'dismissed')}>Dismiss</button>
                </>
              )}
              {c.status !== 'open' && (
                <button className="btn small secondary" onClick={() => setStatus(c.id, 'open')}>Reopen</button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

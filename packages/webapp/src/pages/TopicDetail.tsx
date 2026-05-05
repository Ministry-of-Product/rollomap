import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Topic } from '../api';

type TopicDetail = {
  topic: Topic;
  people: { id: string; display_name: string; company: string | null; title: string | null; confidence: number; user_confirmed: boolean; last_evidence_at: string | null }[];
};

export function TopicDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<TopicDetail | null>(null);
  useEffect(() => { if (id) api.get<TopicDetail>(`/topics/${id}`).then(setData); }, [id]);
  if (!data) return <div className="empty">Loading…</div>;
  return (
    <div>
      <Link to="/topics" className="meta">← Topics</Link>
      <h2 style={{ margin: '4px 0 0' }}>{data.topic.name}</h2>
      {data.topic.description && <p className="meta">{data.topic.description}</p>}
      <h3 style={{ marginTop: 24 }}>People associated with this topic</h3>
      {data.people.length === 0 ? <div className="empty">No people linked yet.</div> : (
        <table>
          <thead><tr><th>Person</th><th>Company</th><th>Confidence</th><th>Confirmed</th></tr></thead>
          <tbody>
            {data.people.map(p => (
              <tr key={p.id}>
                <td><Link to={`/people/${p.id}`}>{p.display_name}</Link></td>
                <td>{[p.company, p.title].filter(Boolean).join(' · ') || <span className="meta">—</span>}</td>
                <td>{Number(p.confidence).toFixed(2)}</td>
                <td>{p.user_confirmed ? 'yes' : <span className="meta">inferred</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

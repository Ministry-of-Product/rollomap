import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Result = {
  person_id: string;
  name: string;
  company: string | null;
  title: string | null;
  summary: string | null;
  relationship_strength: number;
  last_seen_at: string | null;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  matched_topics: string[];
  reason: string;
  evidence: { interaction_id: string; title: string | null; summary: string | null; occurred_at: string }[];
};

export function AskPage() {
  const [idea, setIdea] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idea.trim()) return;
    setLoading(true);
    setError(null);
    setSubmitted(idea.trim());
    try {
      const res = await api.post<{ results: Result[] }>('/query/people-for-idea', { idea: idea.trim(), limit: 15 });
      setResults(res.results);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2>Ask</h2>
      <p className="meta" style={{ maxWidth: 640 }}>
        Ask who in your network might care about an idea, opportunity, or problem.
        Results are ranked by topic match, prior interactions, and relationship strength —
        every claim links back to evidence in your sources.
      </p>
      <form onSubmit={onSubmit}>
        <textarea
          value={idea}
          onChange={e => setIdea(e.target.value)}
          placeholder="e.g. Who in my network might care about AI tools for family meal planning?"
        />
        <div style={{ marginTop: 8 }}>
          <button className="btn" type="submit" disabled={loading}>
            {loading ? 'Thinking…' : 'Find people'}
          </button>
        </div>
      </form>

      {error && <div className="card" style={{ borderColor: 'var(--danger)' }}>{error}</div>}

      {submitted && !loading && (
        <div style={{ marginTop: 24 }}>
          <h3>Results for "{submitted}"</h3>
          {results.length === 0 ? (
            <div className="empty">No matches yet — try adding more interactions or topics.</div>
          ) : results.map(r => (
            <div key={r.person_id} className="card">
              <div className="row between">
                <div>
                  <Link to={`/people/${r.person_id}`}><strong>{r.name}</strong></Link>
                  <div className="meta">{[r.title, r.company].filter(Boolean).join(' · ')}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span className={`confidence-${r.confidence}`}>{r.confidence} confidence</span>
                  <div className="meta">score {r.score.toFixed(1)}</div>
                </div>
              </div>
              <div className="score-bar"><span style={{ width: `${Math.min(100, r.score * 1.3)}%` }} /></div>
              <p style={{ marginTop: 8 }}>{r.reason}</p>
              {r.matched_topics?.filter(Boolean).map(t => <span key={t} className="tag confirmed">{t}</span>)}
              {r.evidence?.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <strong style={{ fontSize: 12, color: 'var(--text-dim)' }}>Evidence</strong>
                  {r.evidence.map(ev => (
                    <div key={ev.interaction_id} className="timeline-item" style={{ marginTop: 4 }}>
                      <div>{ev.title || ev.summary}</div>
                      <div className="when">{new Date(ev.occurred_at).toLocaleDateString()}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Cloud Pairing page (MIN-974).
 * Connect this client to RolloMap Cloud by entering a sync server URL and
 * device token obtained from the cloud dashboard.
 */

import { useEffect, useState } from 'react';
import { api } from '../api';

type CloudStatus =
  | { paired: false }
  | {
      paired: true;
      sync_server_url: string;
      connected_at: string;
      last_check_at: string | null;
      last_check_ok: boolean | null;
    };

export function CloudPage() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<string | null>(null);

  const loadStatus = async () => {
    setLoading(true);
    try {
      const s = await api.get<CloudStatus>('/cloud/status');
      setStatus(s);
    } catch {
      setStatus({ paired: false });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  const onConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnecting(true);
    setError(null);
    try {
      await api.post('/cloud/connect', {
        sync_server_url: serverUrl.trim(),
        device_token: token.trim(),
      });
      setServerUrl('');
      setToken('');
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  const onDisconnect = async () => {
    setError(null);
    try {
      await api.post('/cloud/disconnect');
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onSeed = async () => {
    setSeeding(true);
    setSeedResult(null);
    setError(null);
    try {
      const r = await api.post<{ totals: { emitted: number; skipped: number }; notPushable: { commitments: number } }>('/cloud/backfill');
      setSeedResult(
        `Seeded ${r.totals.emitted} events (${r.totals.skipped} already had events). ` +
        (r.notPushable.commitments > 0 ? `${r.notPushable.commitments} commitment(s) skipped — no wire op yet.` : ''),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSeeding(false);
    }
  };

  if (loading) return <div className="empty">Loading…</div>;

  return (
    <div>
      <h2>Cloud Sync</h2>

      {status?.paired ? (
        <div className="card">
          <p>
            <strong>Connected</strong> to{' '}
            <code>{status.sync_server_url}</code>
          </p>
          <div className="meta">
            Paired: {new Date(status.connected_at).toLocaleString()}
            {status.last_check_at && (
              <>
                {' · '}Last check: {new Date(status.last_check_at).toLocaleString()}{' '}
                {status.last_check_ok === true && <span style={{ color: 'green' }}>OK</span>}
                {status.last_check_ok === false && <span style={{ color: 'red' }}>Failed</span>}
              </>
            )}
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={onDisconnect}>Disconnect</button>
            <button className="btn" onClick={onSeed} disabled={seeding}>
              {seeding ? 'Seeding…' : 'Seed cloud'}
            </button>
          </div>
          {seedResult && (
            <div className="meta" style={{ marginTop: 8 }}>{seedResult}</div>
          )}
          {error && <div className="meta" style={{ color: 'red', marginTop: 8 }}>{error}</div>}
        </div>
      ) : (
        <div className="card">
          <p className="meta">
            Pair this client with RolloMap Cloud to enable sync. Sign into
            RolloMap Cloud, register a device, and paste the one-time token
            below.
          </p>
          <form onSubmit={onConnect} style={{ marginTop: 12 }}>
            <div style={{ marginBottom: 8 }}>
              <label>Sync server URL</label>
              <input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://sync.rollomap.com"
                required
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label>Device token</label>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste the one-time token here"
                required
                type="password"
                style={{ width: '100%' }}
              />
            </div>
            <button className="btn" type="submit" disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect to Cloud'}
            </button>
          </form>
          {error && <div className="meta" style={{ color: 'red', marginTop: 8 }}>{error}</div>}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api, SourceItem } from '../api';

export function SourcesPage() {
  const [items, setItems] = useState<SourceItem[]>([]);
  const [importJson, setImportJson] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const load = async () => {
    const res = await api.get<{ source_items: SourceItem[] }>('/sources/items?limit=200');
    setItems(res.source_items);
  };
  useEffect(() => { load(); }, []);

  const onImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setImportMsg(null);
    let payload: unknown;
    try {
      payload = JSON.parse(importJson);
    } catch {
      setImportMsg('Invalid JSON.');
      return;
    }
    const items = Array.isArray(payload) ? payload : (payload as { items?: unknown }).items;
    if (!Array.isArray(items)) {
      setImportMsg('Expected an array of items, or { "items": [...] }');
      return;
    }
    try {
      const res = await api.post<{ inserted: number; people_created: number }>('/sources/import', { items });
      setImportMsg(`Imported ${res.inserted} items, created ${res.people_created} new people.`);
      setImportJson('');
      load();
    } catch (err) {
      setImportMsg(String(err));
    }
  };

  return (
    <div>
      <h2>Sources</h2>
      <p className="meta">Imported items contribute to your relationship memory. In v1 only manual + JSON import are wired up; OAuth connectors come later.</p>

      <div className="card">
        <h3>Import JSON</h3>
        <p className="meta">
          Paste an array of source items. Each item: <code>{`{ source_type: "email"|"doc"|"meeting_note"|"calendar_event"|"linkedin"|"note", title?, body?, author?, participants?, person_emails?, created_at_source? }`}</code>.
          Items with <code>person_emails</code> auto-create people and link them as participants of an interaction.
        </p>
        <form onSubmit={onImport}>
          <textarea
            value={importJson}
            onChange={e => setImportJson(e.target.value)}
            placeholder={`[\n  { "source_type": "email", "title": "Re: meal planning", "body": "...", "person_emails": ["jane@example.com"], "created_at_source": "2026-04-20" }\n]`}
            style={{ minHeight: 160, fontFamily: 'ui-monospace, monospace' }}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" type="submit">Import</button>
            {importMsg && <span className="meta">{importMsg}</span>}
          </div>
        </form>
      </div>

      <h3>Recent source items ({items.length})</h3>
      {items.length === 0 ? <div className="empty">No source items yet.</div> : (
        <table>
          <thead><tr><th>Title</th><th>Type</th><th>Provider</th><th>When</th><th>Length</th></tr></thead>
          <tbody>
            {items.map(i => (
              <tr key={i.id}>
                <td>{i.title || <span className="meta">(untitled)</span>}</td>
                <td><span className="tag">{i.source_type}</span></td>
                <td className="meta">{i.provider}</td>
                <td className="meta">
                  {i.created_at_source
                    ? new Date(i.created_at_source).toLocaleDateString()
                    : new Date(i.ingested_at).toLocaleDateString()}
                </td>
                <td className="meta">{i.body_length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

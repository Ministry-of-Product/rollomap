import { NavLink, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from './api';
import { PeoplePage } from './pages/People';
import { PersonProfilePage } from './pages/PersonProfile';
import { InteractionsPage } from './pages/Interactions';
import { TopicsPage } from './pages/Topics';
import { TopicDetailPage } from './pages/TopicDetail';
import { AskPage } from './pages/Ask';
import { OpenLoopsPage } from './pages/OpenLoops';
import { SourcesPage } from './pages/Sources';
import { ReviewPage } from './pages/Review';
import { CloudPage } from './pages/Cloud';

type Stats = {
  people: string; interactions: string; topics: string;
  source_items: string; open_commitments: string; notes: string;
};

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    api.get<Stats>('/stats').then(setStats).catch(() => setStats(null));
  }, []);

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>RolloMap</h1>
        <nav>
          <NavLink to="/ask" className={({ isActive }) => isActive ? 'active' : ''}>Ask</NavLink>
          <NavLink to="/people" className={({ isActive }) => isActive ? 'active' : ''}>People</NavLink>
          <NavLink to="/topics" className={({ isActive }) => isActive ? 'active' : ''}>Topics</NavLink>
          <NavLink to="/interactions" className={({ isActive }) => isActive ? 'active' : ''}>Interactions</NavLink>
          <NavLink to="/open-loops" className={({ isActive }) => isActive ? 'active' : ''}>Open loops</NavLink>
          <NavLink to="/review" className={({ isActive }) => isActive ? 'active' : ''}>Review</NavLink>
          <NavLink to="/sources" className={({ isActive }) => isActive ? 'active' : ''}>Sources</NavLink>
          <NavLink to="/cloud" className={({ isActive }) => isActive ? 'active' : ''}>Cloud</NavLink>
        </nav>
        {stats && (
          <div className="stats">
            <hr />
            <div><span>People</span><span>{stats.people}</span></div>
            <div><span>Interactions</span><span>{stats.interactions}</span></div>
            <div><span>Topics</span><span>{stats.topics}</span></div>
            <div><span>Sources</span><span>{stats.source_items}</span></div>
            <div><span>Open loops</span><span>{stats.open_commitments}</span></div>
            <div><span>Notes</span><span>{stats.notes}</span></div>
          </div>
        )}
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<AskPage />} />
          <Route path="/ask" element={<AskPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/people/:id" element={<PersonProfilePage />} />
          <Route path="/topics" element={<TopicsPage />} />
          <Route path="/topics/:id" element={<TopicDetailPage />} />
          <Route path="/interactions" element={<InteractionsPage />} />
          <Route path="/open-loops" element={<OpenLoopsPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/cloud" element={<CloudPage />} />
        </Routes>
      </main>
    </div>
  );
}

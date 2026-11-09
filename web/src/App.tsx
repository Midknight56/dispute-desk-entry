import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDisputes, getFeed, getMe, getNext, getShipNext } from './api';
import type { FeedRow } from './api';
import type { Dispute } from './format';
import { tileValues } from './format';
import Tiles from './components/Tiles';
import DisputeGrid from './components/DisputeGrid';
import CasePanel from './components/CasePanel';
import Feed from './components/Feed';
import Ask from './widgets/Ask';
import { firstSelection, type JudgeRow } from './judge';

export function readCaseId(search: string, knownIds: Iterable<string>): string | null {
  const id = new URLSearchParams(search).get('case');
  if (!id) return null;
  for (const knownId of knownIds) {
    if (knownId === id) return id;
  }
  return null;
}

export default function App() {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [replays, setReplays] = useState<Record<string, { label: string; run: import('./api').Run; dispute: Dispute }>>(
    {},
  );
  const [ownerKey, setOwnerKey] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [caseRefs, setCaseRefs] = useState<string[]>([]);
  const [offline, setOffline] = useState(false);
  const [updatesDelayed, setUpdatesDelayed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const assigned = useRef({ fight: false, accept: false, ship: false });
  const visitorRef = useRef<Awaited<ReturnType<typeof getMe>>>({ cases: [] });
  const mineRef = useRef(mine);
  const replaysRef = useRef(replays);
  const running = useRef(false);
  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      let key: string | null = null;
      try {
        key = window.sessionStorage.getItem('desk-key');
        const params = new URLSearchParams(window.location.search);
        const queryKey = params.get('key');
        if (queryKey) {
          key = queryKey;
          window.sessionStorage.setItem('desk-key', queryKey);
          params.delete('key');
          const search = params.toString();
          window.history.replaceState(
            null,
            '',
            `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
          );
        }
      } catch {
        key = null;
      }
      setOwnerKey(key);
      let delayed = false;
      const nextReplays = { ...replaysRef.current };
      for (const kind of ['fight', 'accept', 'ship'] as const) {
        if (assigned.current[kind]) continue;
        try {
          const result = kind === 'ship' ? await getShipNext() : await getNext(kind);
          if (result.replay && typeof result.replay === 'object') {
            nextReplays[result.replay.dispute.id] = {
              label: result.replay.label,
              run: result.replay.run,
              dispute: { ...result.replay.dispute, updated_at: '' },
            };
          }
          assigned.current[kind] = true;
        } catch {
          delayed = true;
        }
      }
      // Retain successful assignments even if a later request fails.
      replaysRef.current = nextReplays;
      setReplays(nextReplays);
      try {
        const visitor = await getMe();
        visitorRef.current = visitor;
        mineRef.current = new Set(visitor.cases.map((item) => item.dispute_id));
        setMine(mineRef.current);
      } catch {
        delayed = true;
      }
      const nextMine = mineRef.current;
      const [items] = await Promise.all([
        getDisputes(),
        getFeed()
          .then(setFeed)
          .catch(() => {
            delayed = true;
          }),
      ]);
      for (const replay of Object.values(nextReplays)) {
        if (!items.some((item) => item.id === replay.dispute.id)) items.push(replay.dispute);
      }
      const tagged = items.map((item): JudgeRow => ({
        ...item,
        ...(visitorRef.current.cases.find((entry) => entry.dispute_id === item.id)?.kind
          ? { kind: visitorRef.current.cases.find((entry) => entry.dispute_id === item.id)?.kind }
          : {}),
        ...(nextReplays[item.id] ? { replay: true } : {}),
      }));
      setDisputes(items);
      setLoaded(true);
      setUpdatesDelayed(delayed);
      setOffline(false);
      setRefreshKey((key) => key + 1);
      const linkedCase = readCaseId(
        window.location.search,
        items.map((item) => item.id),
      );
      setSelected((current) =>
        current && items.some((item) => item.id === current)
          ? current
          : (linkedCase ?? firstSelection(tagged, nextMine)),
      );
    } catch {
      setOffline(true);
    } finally {
      running.current = false;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  const tiles = useMemo(() => tileValues(disputes), [disputes]);
  const selectCase = useCallback((id: string) => {
    setSelected(id);
    if (window.matchMedia('(max-width: 1023px)').matches) {
      window.requestAnimationFrame(() => document.querySelector('.case-panel')?.scrollIntoView({ block: 'start' }));
    }
    const params = new URLSearchParams(window.location.search);
    params.set('case', id);
    const search = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    );
  }, []);
  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>Dispute Desk</h1>
        <a className="studio-link" href="/studio.html">
          Studio
        </a>
        <a className="studio-link" href="/proof.html">
          Proof
        </a>
      </header>
      {offline && <div className="offline global-offline">Offline, retrying</div>}
      {!offline && updatesDelayed && <div className="offline global-offline">Some updates did not load. Retrying.</div>}
      <main>
        <Tiles values={tiles} loaded={loaded} />
        <Ask />
        <div className="workspace">
          <div className="left-column">
            <DisputeGrid
              rows={disputes}
              loaded={loaded}
              mine={mine}
              replays={Object.keys(replays)}
              selected={selected}
              onSelect={selectCase}
            />
          </div>
          <CasePanel
            id={selected}
            created={disputes.find((d) => d.id === selected)?.created}
            refreshKey={refreshKey}
            mine={mine}
            ownerKey={ownerKey}
            replay={selected ? replays[selected] : undefined}
            onRefs={setCaseRefs}
          />
        </div>
        <Feed rows={feed} caseRefs={caseRefs} />
      </main>
    </div>
  );
}

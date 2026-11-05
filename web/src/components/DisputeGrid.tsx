import { statusLabel, statusTone, formatDeadline } from '../format';
export { formatDeadline } from '../format';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GridApi } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import type { Dispute } from '../format';
import { formatMoney, reasonLabel } from '../format';
import { colors } from '../theme';
import { defaultTab, pageOfRow, rowsForTab, selectedFirst, sortRows, tabCounts, type CaseTab, type JudgeRow } from '../judge';
import Readiness from '../widgets/ReadinessCell';
import { firstLoadFinished } from '../errors';

ModuleRegistry.registerModules([AllCommunityModule]);

export function leaveGridOnTab(): false {
  return false;
}

export function opensCaseOnRowKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

export function disputeGridColumns(mine: Set<string>, replays: string[]): ColDef<Dispute>[] {
  return [
    {
      colId: 'ownership',
      headerName: '',
      width: 72,
      minWidth: 72,
      sortable: false,
      cellStyle: { paddingLeft: 4, paddingRight: 4 },
      cellRenderer: (p: { data?: Dispute }) => {
        if (!p.data) return null;
        const replay = replays.includes(p.data.id);
        const yours = mine.has(p.data.id);
        return replay || yours ? (
          <span className="status-pill ownership-pill">{replay ? 'Replay' : 'Yours'}</span>
        ) : null;
      },
    },
    { field: 'id', headerName: 'Case', width: 160, minWidth: 160 },
    {
      field: 'reason',
      headerName: 'Reason',
      minWidth: 140,
      flex: 1,
      valueFormatter: (p: { value: string }) => reasonLabel(p.value),
    },
    {
      colId: 'evidence',
      headerName: 'Proof',
      minWidth: 76,
      width: 76,
      sortable: false,
      cellRenderer: (p: { data?: Dispute }) => <Readiness data={p.data} />,
    },
    {
      field: 'amount',
      headerName: 'Amount',
      minWidth: 72,
      width: 72,
      type: 'rightAligned',
      valueFormatter: (p) => formatMoney(p.value ?? '0', p.data?.currency),
    },
    {
      field: 'status',
      headerName: 'Status',
      minWidth: 124,
      width: 124,
      cellRenderer: (p: { value: string }) => (
        <span className={`status-pill ${statusTone(p.value)}`}>{statusLabel(p.value)}</span>
      ),
    },
    {
      field: 'due',
      headerName: 'Due',
      minWidth: 78,
      width: 78,
      cellRenderer: (p: { value: string | null }) => {
        const date = p.value ? new Date(p.value) : null;
        const title = date && Number.isFinite(date.getTime()) ? date.toLocaleString() : undefined;
        return <span title={title}>{formatDeadline(p.value)}</span>;
      },
    },
  ];
}

const gridTheme = themeQuartz.withParams({
  backgroundColor: colors.surface,
  foregroundColor: colors.text,
  borderColor: colors.line,
  headerBackgroundColor: colors.bg,
  headerTextColor: colors.muted,
  rowHoverColor: colors.bg,
  fontFamily: 'system-ui, sans-serif',
  fontSize: 14,
  cellHorizontalPadding: 10,
  accentColor: colors.accent,
});

function usePhone() {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return phone;
}

export default function DisputeGrid({
  rows,
  loaded,
  mine,
  replays,
  selected,
  onSelect,
}: {
  rows: Dispute[];
  loaded: boolean;
  mine: Set<string>;
  replays: string[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const phone = usePhone();
  const [chosenTab, setChosenTab] = useState<CaseTab | null>(null);
  const [visible, setVisible] = useState(10);
  const tab = chosenTab ?? defaultTab(rows);
  const counts = tabCounts(rows);
  const revealed = useRef<string | null>(null);
  const gridApi = useRef<GridApi<Dispute> | null>(null);
  const orderedRows = useMemo(
    () =>
      selectedFirst(
        sortRows(
          rowsForTab(rows, tab, mine, selected).map((row): JudgeRow => ({
            ...row,
            replay: replays.includes(row.id),
          })),
          mine,
        ),
        tab,
        selected,
      ),
    [rows, mine, replays, tab, selected],
  );
  const columns = useMemo(() => disputeGridColumns(mine, replays), [mine, replays]);
  const revealSelected = useCallback(
    (api: GridApi<Dispute> | null = gridApi.current) => {
      if (!api || !selected || revealed.current === selected) return;
      const node = api.getRowNode(selected);
      if (!node) return;
      if (node.rowIndex == null) return;
      api.paginationGoToPage(pageOfRow(node.rowIndex, 12));
      api.ensureNodeVisible(node, 'middle');
      revealed.current = selected;
      api.setNodesSelected({ nodes: [node], newValue: true });
    },
    [selected],
  );
  useEffect(() => {
    if (phone) {
      gridApi.current = null;
      revealed.current = null;
    } else revealSelected();
  }, [revealSelected, phone]);
  return (
    <section className="card grid-card">
      {loaded && !rows.length ? (
        <div className="case-empty">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M4 20 9 6h14l5 14v7H4z M4 20h8l2 3h4l2-3h8" />
          </svg>
          <h2>No disputes yet</h2>
          <p>New cases show here.</p>
        </div>
      ) : (
        <>
          <div className="case-tabs" role="group" aria-label="Filter cases">
            {(
              [
                ['move', 'Your move'],
                ['waiting', 'Waiting'],
                ['settled', 'Settled'],
                ['all', 'All'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={tab === value}
                onClick={() => {
                  setChosenTab(value);
                  setVisible(10);
                }}
              >
                {label} {counts[value]}
              </button>
            ))}
          </div>
          {phone ? (
            !loaded ? (
              <p className="muted-line">Loading cases</p>
            ) : (
              <>
                <ul className="case-list">
                  {orderedRows.slice(0, visible).map((row) => (
                    <li key={row.id}>
                      <button
                        className="case-row"
                        aria-current={selected === row.id ? 'true' : undefined}
                        onClick={() => onSelect(row.id)}
                      >
                        <span className="case-row-line">
                          <strong>{formatMoney(row.amount, row.currency)}</strong>
                          <span className={`status-pill ${statusTone(row.status)}`}>{statusLabel(row.status)}</span>
                        </span>
                        <span className="case-row-line case-row-reason">
                          <span>{reasonLabel(row.reason)}</span>
                          {(mine.has(row.id) || row.replay) && (
                            <span className="status-pill ownership-pill">{row.replay ? 'Replay' : 'Yours'}</span>
                          )}
                          {row.due && <span className="case-row-due">{formatDeadline(row.due)}</span>}
                        </span>
                        <span className="case-row-id">{row.id}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {orderedRows.length > visible && (
                  <button className="show-more" onClick={() => setVisible((count) => count + 10)}>
                    Show more
                  </button>
                )}
              </>
            )
          ) : (
            <AgGridReact
              rowData={orderedRows}
              columnDefs={columns}
              getRowId={(p) => p.data.id}
              onGridReady={(event) => {
                gridApi.current = event.api;
                revealSelected(event.api);
              }}
              onRowDataUpdated={() => revealSelected()}
              pagination
              paginationPageSize={12}
              paginationPageSizeSelector={false}
              domLayout="autoHeight"
              theme={gridTheme}
              loading={!firstLoadFinished(loaded)}
              localeText={{ noRowsToShow: 'No disputes yet' }}
              rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
              tabToNextCell={leaveGridOnTab}
              onRowClicked={(event) => event.data && onSelect(event.data.id)}
              onCellKeyDown={(event) => {
                const keyboardEvent = event.event as KeyboardEvent | null | undefined;
                if (event.data && keyboardEvent && opensCaseOnRowKey(keyboardEvent.key)) onSelect(event.data.id);
              }}
              rowClassRules={{ 'selected-row': (p) => p.data?.id === selected }}
            />
          )}
        </>
      )}
    </section>
  );
}

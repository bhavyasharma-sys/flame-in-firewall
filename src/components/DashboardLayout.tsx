import React, { useState } from 'react';
import { useNotebookState } from '../context/NotebookStateContext';
import type { RunScoreRow, TelemetryMetric } from '../types/notebook';
import { ChatMessage } from './ChatMessage';
import { Sidebar } from './Sidebar';

interface DashboardLayoutProps {
  version?: string;
  licenseBadge?: string;
  metrics?: TelemetryMetric[];
  runs?: RunScoreRow[];
  chartsSlot?: React.ReactNode;
  onDispatchQuery?: (query: string, sessionId: string) => void;
}

const DEFAULT_METRICS: TelemetryMetric[] = [
  { id: 'runs', label: 'PSI Test Runs', value: '50', delta: '12 missions', tone: 'flame' },
  { id: 'grounding', label: 'Citation Grounding', value: '98.4%', delta: '239 chunks', tone: 'emerald' },
  { id: 'kg', label: 'Knowledge Graph', value: '227', delta: '342 edges', tone: 'cyan' },
  { id: 'loi', label: 'Artemis PMMA LOI', value: '17.6%', delta: 'Risk 88/100', tone: 'amber' },
];

const DEFAULT_RUNS: RunScoreRow[] = [
  {
    runId: 'RUN-014',
    program: 'SoFIE',
    fuel: 'PMMA',
    oxygenPct: 34.0,
    pressureKpa: 56.5,
    flowCmS: 5.0,
    gravityG: 0.16,
    regime: 'Sustained Burn',
    score: 96.4,
  },
  {
    runId: 'RUN-027',
    program: 'BASS-II',
    fuel: 'Cotton-FG',
    oxygenPct: 21.0,
    pressureKpa: 101.3,
    flowCmS: 8.0,
    gravityG: 0.0,
    regime: 'Sustained Burn',
    score: 91.8,
  },
  {
    runId: 'RUN-041',
    program: 'FLEX-2',
    fuel: 'n-Heptane',
    oxygenPct: 21.0,
    pressureKpa: 101.3,
    flowCmS: 0.0,
    gravityG: 0.0,
    regime: 'Cool Flame',
    score: 88.2,
  },
  {
    runId: 'RUN-009',
    program: 'SAFFIRE-IV',
    fuel: 'Nomex',
    oxygenPct: 21.0,
    pressureKpa: 101.3,
    flowCmS: 20.0,
    gravityG: 0.0,
    regime: 'Self-Extinguished',
    score: 84.5,
  },
];

const TONE_VALUE_CLASS: Record<NonNullable<TelemetryMetric['tone']>, string> = {
  flame: 'text-orange-400',
  cyan: 'text-sky-400',
  emerald: 'text-emerald-400',
  amber: 'text-amber-400',
  neutral: 'text-zinc-100',
};

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({
  version = 'v1.0.0',
  licenseBadge = 'NASA NTRS • MIT',
  metrics = DEFAULT_METRICS,
  runs = DEFAULT_RUNS,
  chartsSlot,
  onDispatchQuery,
}) => {
  const {
    activeWorkspace,
    activeNotebook,
    activeNotebookChat,
    activeRecentChat,
    activeSessionId,
    isSidebarOpen,
    openDashboard,
    appendMessageToActiveSession,
  } = useNotebookState();

  const [draft, setDraft] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = draft.trim();
    if (!q) return;
    setDraft('');
    appendMessageToActiveSession({ role: 'user', content: q });
    onDispatchQuery?.(q, activeSessionId);
  };

  const activeMessages = activeNotebookChat
    ? activeNotebookChat.messages
    : activeRecentChat
      ? activeRecentChat.messages
      : [];

  return (
    <div className="flex min-h-screen w-full bg-[#060504] text-zinc-100 antialiased">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Precision Telemetry Header */}
        <header
          className={`sticky top-0 z-30 flex h-14 items-center justify-between border-b border-zinc-800/80 bg-[#060504]/90 px-6 backdrop-blur-xl transition-all ${
            !isSidebarOpen ? 'pl-14' : ''
          }`}
        >
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={openDashboard}
              className="flex items-center gap-2 text-left"
            >
              <span className="text-[15px] font-extrabold tracking-tight text-white">
                IGNIS
              </span>
              <span className="rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-zinc-300">
                {version}
              </span>
            </button>

            <span className="hidden h-4 w-px bg-zinc-800 sm:inline-block" />

            <div className="hidden items-center gap-2 sm:flex">
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-emerald-300">
                NASA-STD-6001B
              </span>
              <span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-2 py-0.5 font-mono text-[10.5px] text-zinc-400">
                {licenseBadge}
              </span>
            </div>
          </div>

          {/* Live Cabin Telemetry Readout Pill */}
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2.5 rounded-full border border-zinc-800 bg-zinc-900/75 px-3 py-1 font-mono text-[11px] tabular-nums text-zinc-300 md:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
              <span>
                {activeNotebook
                  ? `${activeNotebook.snapshot.oxygenPct}% O₂ • ${activeNotebook.snapshot.pressureKpa} kPa • ${activeNotebook.snapshot.flowVelocityCmS} cm/s • ${activeNotebook.snapshot.gravityG}g • ${activeNotebook.snapshot.fuelMaterial}`
                  : '21.0% O₂ • 101.3 kPa • 10.0 cm/s • 0.0g • PMMA'}
              </span>
            </div>

            {activeWorkspace.kind !== 'dashboard' && (
              <button
                type="button"
                onClick={openDashboard}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[11px] font-semibold text-zinc-300 transition hover:border-zinc-700 hover:text-white"
              >
                Dashboard
              </button>
            )}
          </div>
        </header>

        {/* Main Workspace Surface with Optimized Whitespace */}
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 p-6 lg:p-10">
          {activeWorkspace.kind === 'dashboard' && (
            <>
              {/* Minimalist KPI Grid — Quantifiable Metrics Only */}
              <section
                aria-label="Telemetry metrics"
                className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4"
              >
                {metrics.map((m) => (
                  <div
                    key={m.id}
                    className="rounded-2xl border border-zinc-800/90 bg-zinc-950/70 p-5"
                  >
                    <div className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400">
                      {m.label}
                    </div>
                    <div
                      className={`mt-2 font-mono text-3xl font-bold tracking-tight tabular-nums ${
                        TONE_VALUE_CLASS[m.tone ?? 'neutral']
                      }`}
                    >
                      {m.value}
                    </div>
                    {m.delta && (
                      <div className="mt-1.5 font-mono text-[11.5px] tabular-nums text-zinc-500">
                        {m.delta}
                      </div>
                    )}
                  </div>
                ))}
              </section>

              {/* Charts Slot (Clean Spacing, Zero Descriptive Clutter) */}
              {chartsSlot && (
                <section aria-label="Telemetry charts" className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  {chartsSlot}
                </section>
              )}

              {/* Precision Run Score Data Grid */}
              <section
                aria-label="Run score matrix"
                className="overflow-hidden rounded-2xl border border-zinc-800/90 bg-zinc-950/70"
              >
                <div className="flex items-center justify-between border-b border-zinc-800/80 px-6 py-4">
                  <h2 className="text-[14px] font-bold tracking-tight text-zinc-100">
                    Telemetry Run Scores
                  </h2>
                  <span className="font-mono text-[11px] tabular-nums text-zinc-400">
                    {runs.length} runs indexed
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left font-mono text-[12px] tabular-nums">
                    <thead>
                      <tr className="border-b border-zinc-800/80 text-[10.5px] uppercase tracking-wider text-zinc-500">
                        <th className="px-6 py-3 font-semibold">Run</th>
                        <th className="px-4 py-3 font-semibold">Program</th>
                        <th className="px-4 py-3 font-semibold">Fuel</th>
                        <th className="px-4 py-3 font-semibold">O₂ / P</th>
                        <th className="px-4 py-3 font-semibold">Flow / g</th>
                        <th className="px-4 py-3 font-semibold">Regime</th>
                        <th className="px-6 py-3 text-right font-semibold">Score</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900">
                      {runs.map((r) => (
                        <tr key={r.runId} className="transition hover:bg-zinc-900/60">
                          <td className="px-6 py-3.5 font-semibold text-zinc-100">
                            {r.runId}
                          </td>
                          <td className="px-4 py-3.5 text-zinc-300">{r.program}</td>
                          <td className="px-4 py-3.5 text-zinc-300">{r.fuel}</td>
                          <td className="px-4 py-3.5 text-zinc-400">
                            {r.oxygenPct}% • {r.pressureKpa} kPa
                          </td>
                          <td className="px-4 py-3.5 text-zinc-400">
                            {r.flowCmS} cm/s • {r.gravityG}g
                          </td>
                          <td className="px-4 py-3.5">
                            <span className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300">
                              {r.regime}
                            </span>
                          </td>
                          <td className="px-6 py-3.5 text-right font-bold text-orange-400">
                            {r.score.toFixed(1)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}

          {/* Isolated Notebook Workspace OR Standalone Recent Chat Thread */}
          {(activeNotebook || activeRecentChat) && (
            <section className="flex flex-1 flex-col gap-4 bg-transparent">
              {/* Unboxed Document-Style Message Stream */}
              <div className="flex flex-1 flex-col bg-transparent py-2">
                {activeMessages.length === 0 ? (
                  <div className="my-auto flex flex-col items-center justify-center py-12 text-center font-mono text-[12px] text-zinc-500">
                    <span>
                      {activeNotebookChat
                        ? `SESSION ${activeNotebookChat.sessionId} • 0 msgs`
                        : `SESSION ${activeRecentChat?.sessionId} • 0 msgs`}
                    </span>
                  </div>
                ) : (
                  activeMessages.map((msg) => (
                    <ChatMessage key={msg.id} message={msg} />
                  ))
                )}
              </div>
            </section>
          )}

          {/* Minimalist Query Bar */}
          <form
            onSubmit={handleSubmit}
            className="sticky bottom-5 z-20 mx-auto flex w-full max-w-3xl items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/90 p-2 shadow-2xl backdrop-blur-xl"
          >
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                activeNotebook
                  ? `Query ${activeNotebook.title}...`
                  : 'Query NASA combustion corpus...'
              }
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-[13.5px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              className="rounded-xl bg-orange-500 px-4 py-2 text-[12.5px] font-semibold text-white transition hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Run Query
            </button>
          </form>
        </main>
      </div>
    </div>
  );
};

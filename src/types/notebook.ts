export type ChatRole = 'user' | 'assistant';

export interface CabinSnapshot {
  oxygenPct: number;
  pressureKpa: number;
  flowVelocityCmS: number;
  gravityG: number;
  fuelMaterial: string;
  diluentGas: 'N2' | 'CO2' | 'He' | 'Ar';
  riskIndex?: number;
}

export interface ChatCitation {
  id: string;
  label: string;
  page?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  citations?: ChatCitation[];
  groundingPct?: number;
}

export interface NotebookChat {
  id: string;
  title: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface Notebook {
  id: string;
  title: string;
  runCount: number;
  createdAt: number;
  updatedAt: number;
  snapshot: CabinSnapshot;
  activeChatId: string;
  chats: NotebookChat[];
}

export interface RecentChat {
  id: string;
  title: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export type ActiveWorkspace =
  | { kind: 'dashboard' }
  | { kind: 'notebook'; notebookId: string; chatId: string }
  | { kind: 'chat'; chatId: string };

export interface TelemetryMetric {
  id: string;
  label: string;
  value: string;
  delta?: string;
  unit?: string;
  tone?: 'flame' | 'cyan' | 'emerald' | 'amber' | 'neutral';
}

export interface RunScoreRow {
  runId: string;
  program: string;
  fuel: string;
  oxygenPct: number;
  pressureKpa: number;
  flowCmS: number;
  gravityG: number;
  regime: string;
  score: number;
}

import React from 'react';
import type { ChatCitation, ChatMessage as ChatMessageModel } from '../types/notebook';

export interface ChatMessageProps {
  message: ChatMessageModel;
  onCitationClick?: (citation: ChatCitation) => void;
}

function stripRedundantHeaders(raw: string): string {
  return raw
    .replace(
      /^(?:#{1,4}\s*|\*\*)?FlameAI\s+Grounded\s+Synthesis(?:\s*[—–-]\s*.*)?\*?\*?\s*\n+/i,
      ''
    )
    .replace(/\n*(?:\*\*|#{1,4}\s*)?Cited NASA Sources:\*?\*?\s*[\s\S]*$/i, '')
    .trim();
}

function renderInlineNodes(
  line: string,
  keyPrefix: string,
  onCitationClick?: (citation: ChatCitation) => void
): React.ReactNode[] {
  const tokenRegex =
    /(`[^`]+`|\*\*[^*]+\*\*|\[(?:DOC|ISS)-[A-Z0-9-]+(?:\s+p\.\d+)?\]|\[EXP-\d{4}\]|\[[^\]]+\]\((?:https?:\/\/|\/papers\/)[^\s)]+\))/g;

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let partIdx = 0;

  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(line.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${partIdx++}`;

    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[12.5px] text-cyan-200"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-white">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (/^\[((?:DOC|ISS)-[A-Z0-9-]+)(?:\s+p\.(\d+))?\]$/.test(token)) {
      const m = token.match(/^\[((?:DOC|ISS)-[A-Z0-9-]+)(?:\s+p\.(\d+))?\]$/)!;
      const docId = m[1];
      const page = m[2] ? Number(m[2]) : undefined;
      const label = page ? `${docId} p.${page}` : docId;
      nodes.push(
        <button
          key={key}
          type="button"
          onClick={() => onCitationClick?.({ id: docId, label, page })}
          className="mx-0.5 inline-flex items-center rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-cyan-300 transition hover:bg-cyan-500/20"
        >
          {label}
        </button>
      );
    } else if (/^\[(EXP-\d{4})\]$/.test(token)) {
      const expId = token.slice(1, -1);
      nodes.push(
        <button
          key={key}
          type="button"
          onClick={() => onCitationClick?.({ id: expId, label: expId })}
          className="mx-0.5 inline-flex items-center rounded-md border border-orange-500/35 bg-orange-500/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-orange-300 transition hover:bg-orange-500/20"
        >
          {expId}
        </button>
      );
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(((?:https?:\/\/|\/papers\/)[^\s)]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <a
            key={key}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-cyan-300 underline decoration-cyan-400/40 underline-offset-2 transition hover:decoration-cyan-300"
          >
            {linkMatch[1]} ↗
          </a>
        );
      } else {
        nodes.push(token);
      }
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < line.length) {
    nodes.push(line.slice(lastIndex));
  }

  return nodes;
}

function renderDocumentStream(
  rawContent: string,
  onCitationClick?: (citation: ChatCitation) => void
): React.ReactNode {
  const cleaned = stripRedundantHeaders(rawContent);
  const lines = cleaned.split('\n');
  const blocks: React.ReactNode[] = [];

  let listItems: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let blockIdx = 0;

  const flushList = () => {
    if (!listItems.length) return;
    const key = `list-${blockIdx++}`;
    blocks.push(
      <ul key={key} className="my-2.5 space-y-1.5 pl-5 list-disc marker:text-zinc-500">
        {listItems.map((item, idx) => (
          <li key={`${key}-${idx}`} className="text-[14.5px] leading-relaxed text-zinc-200">
            {renderInlineNodes(item, `${key}-${idx}`, onCitationClick)}
          </li>
        ))}
      </ul>
    );
    listItems = [];
  };

  const flushCode = () => {
    if (!codeLines.length) return;
    const key = `code-${blockIdx++}`;
    blocks.push(
      <pre
        key={key}
        className="my-3 overflow-x-auto rounded-lg bg-white/[0.04] px-4 py-3 font-mono text-[12.5px] leading-relaxed text-zinc-200"
      >
        <code>{codeLines.join('\n')}</code>
      </pre>
    );
    codeLines = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('```')) {
      flushList();
      if (inCodeBlock) {
        flushCode();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    if (!trimmed) {
      flushList();
      continue;
    }

    if (trimmed.startsWith('#### ')) {
      flushList();
      const key = `h4-${blockIdx++}`;
      blocks.push(
        <h4 key={key} className="mt-4 mb-1.5 text-[14px] font-semibold tracking-tight text-orange-300 first:mt-0">
          {renderInlineNodes(trimmed.slice(5), key, onCitationClick)}
        </h4>
      );
    } else if (trimmed.startsWith('### ')) {
      flushList();
      const key = `h3-${blockIdx++}`;
      blocks.push(
        <h3 key={key} className="mt-5 mb-2 text-[16px] font-bold tracking-tight text-white first:mt-0">
          {renderInlineNodes(trimmed.slice(4), key, onCitationClick)}
        </h3>
      );
    } else if (trimmed.startsWith('## ')) {
      flushList();
      const key = `h2-${blockIdx++}`;
      blocks.push(
        <h2 key={key} className="mt-5 mb-2 text-[17px] font-bold tracking-tight text-white first:mt-0">
          {renderInlineNodes(trimmed.slice(3), key, onCitationClick)}
        </h2>
      );
    } else if (trimmed.startsWith('# ')) {
      flushList();
      const key = `h1-${blockIdx++}`;
      blocks.push(
        <h1 key={key} className="mt-5 mb-2 text-[18px] font-bold tracking-tight text-white first:mt-0">
          {renderInlineNodes(trimmed.slice(2), key, onCitationClick)}
        </h1>
      );
    } else if (/^[-*•]\s+/.test(trimmed)) {
      listItems.push(trimmed.replace(/^[-*•]\s+/, ''));
    } else if (/^\d+\.\s+/.test(trimmed)) {
      listItems.push(trimmed.replace(/^\d+\.\s+/, ''));
    } else {
      flushList();
      const key = `p-${blockIdx++}`;
      blocks.push(
        <p key={key} className="my-2.5 text-[14.5px] leading-relaxed text-zinc-200 first:mt-0 last:mb-0">
          {renderInlineNodes(trimmed, key, onCitationClick)}
        </p>
      );
    }
  }

  flushList();
  if (inCodeBlock) flushCode();

  return blocks;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  onCitationClick,
}) => {
  if (message.role === 'user') {
    return (
      <div className="my-4 flex justify-end">
        <div className="max-w-[78%] rounded-2xl rounded-br-sm bg-cyan-500/15 px-4 py-2.5 text-[13.5px] leading-relaxed text-cyan-100 ring-1 ring-cyan-400/30">
          {message.content}
        </div>
      </div>
    );
  }

  // Unboxed AI response — transparent surface merging directly into the canvas
  return (
    <article className="w-full bg-transparent py-4 text-zinc-200">
      <div className="max-w-none bg-transparent">
        {renderDocumentStream(message.content, onCitationClick)}
      </div>

      {(message.citations?.length || typeof message.groundingPct === 'number') && (
        <div className="mt-3 flex flex-wrap items-center gap-2 bg-transparent font-mono text-[11px] text-zinc-400">
          {typeof message.groundingPct === 'number' && (
            <span className="text-emerald-400">
              {message.groundingPct}% Grounded
            </span>
          )}
          {message.citations?.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onCitationClick?.(c)}
              className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-cyan-300 transition hover:bg-cyan-500/20"
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </article>
  );
};

/**
 * FlameAI Co-Pilot: Streaming Hybrid Graph-RAG Chat, Active Cabin Scenario Injection,
 * Clickable NASA Citation Chips, EMBER Sentence-Level Audit / Dropped Claims, & Matplotlib Charts.
 */

import { api } from './api.js';
import {
  appendMessageToActiveThread,
  clearActiveThreadMessages,
  ensureActiveThreadForSend,
  getActiveMessages,
  getActiveNotebook,
  getActiveNotebookChat,
  getActiveSessionId,
} from './notebooks.js';
import { emit, esc, on, renderRichMarkdown, state } from './state.js';

let isStreaming = false;
let includeScenario = true;
let activeSuggestions = [];
let suggestionsSeq = 0;

export function initChat() {
  updateScenarioContextPreview();

  const clearBtn = document.getElementById('chat-clear-btn');
  const scenarioToggle = document.getElementById('chat-include-scenario');

  if (scenarioToggle) {
    scenarioToggle.checked = includeScenario;
    scenarioToggle.addEventListener('change', () => {
      includeScenario = scenarioToggle.checked;
      updateScenarioContextPreview();
    });
  }

  clearBtn?.addEventListener('click', async () => {
    try {
      await api.clearMemory(getActiveSessionId());
    } catch {
      // ignore
    }
    clearActiveThreadMessages();
    renderActiveThread();
  });

  on('cabin:changed', updateScenarioContextPreview);
  on('cabin:pill-refresh', updateScenarioContextPreview);
  on('thread:changed', () => {
    if (!isStreaming) renderActiveThread();
  });
  on('tab:changed', (tab) => {
    if (tab === 'chat' && !isStreaming) refreshQuickPrompts();
  });

  renderActiveThread();
}

export function askChatQuestion(question) {
  if (question) sendMessage(question);
}

function appendWelcomeMessage() {
  const msgs = document.getElementById('chat-messages');
  if (!msgs || msgs.children.length > 0) return;
  const nb = getActiveNotebook();
  const nChat = getActiveNotebookChat();
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.innerHTML = `
    <div class="msg-bubble">
      <div class="mono text-muted" style="font-size:12px;">
        ${nb ? `${esc(nb.title)} · ${esc(nChat?.title || 'Session')} — Ask a question below.` : 'Ask anything about NASA microgravity combustion, spacecraft materials, or your active cabin.'}
      </div>
    </div>
  `;
  msgs.appendChild(row);
}

export function renderActiveThread() {
  const msgs = document.getElementById('chat-messages');
  if (!msgs) return;
  msgs.innerHTML = '';

  const history = getActiveMessages();
  if (!history.length) {
    appendWelcomeMessage();
    refreshQuickPrompts();
    return;
  }

  for (const item of history) {
    if (item.role === 'user') {
      const userRow = document.createElement('div');
      userRow.className = 'msg-row user';
      userRow.innerHTML = `<div class="msg-bubble">${esc(item.content)}</div>`;
      msgs.appendChild(userRow);
    } else {
      const asstRow = document.createElement('div');
      asstRow.className = 'msg-row assistant';
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.innerHTML = renderRichMarkdown(item.content || '');
      asstRow.appendChild(bubble);

      if (item.chart?.image_base64) {
        const chartSlot = document.createElement('div');
        const imgSrc = item.chart.image_base64.startsWith('data:')
          ? item.chart.image_base64
          : `data:image/png;base64,${item.chart.image_base64}`;
        chartSlot.innerHTML = `
          <figure style="margin:10px 0 6px;">
            <img class="chat-chart-img" src="${imgSrc}" alt="${esc(item.chart.title || 'Generated NASA Physics Chart')}" />
          </figure>
        `;
        asstRow.appendChild(chartSlot);
      }

      if (item.audit) {
        const auditSlot = document.createElement('div');
        renderAuditPanel(
          auditSlot,
          item.audit,
          item.sources || [],
          Boolean(item.outOfScope),
          item.audit.provider || ''
        );
        asstRow.appendChild(auditSlot);
      }
      msgs.appendChild(asstRow);
    }
  }
  msgs.scrollTop = msgs.scrollHeight;
  refreshQuickPrompts();
}

function hideQuickPrompts() {
  const wrap = document.getElementById('chat-quick-prompts');
  if (!wrap) return;
  activeSuggestions = [];
  wrap.innerHTML = '';
  wrap.style.display = 'none';
}

function renderQuickPrompts(queries) {
  const wrap = document.getElementById('chat-quick-prompts');
  if (!wrap || !Array.isArray(queries) || queries.length === 0) {
    hideQuickPrompts();
    return;
  }
  activeSuggestions = queries;
  wrap.innerHTML = queries
    .map(
      (p, i) => `
      <button type="button" class="pill-btn" data-qidx="${i}">
        ${esc(p.label)}
      </button>
    `
    )
    .join('');
  wrap.style.display = 'flex';

  wrap.querySelectorAll('[data-qidx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = activeSuggestions[Number(btn.dataset.qidx)];
      if (item?.prompt) sendMessage(item.prompt);
    });
  });
}

async function refreshQuickPrompts() {
  const wrap = document.getElementById('chat-quick-prompts');
  if (!wrap) return;
  const seq = ++suggestionsSeq;

  const history = getActiveMessages()
    .slice(-6)
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 500),
    }))
    .filter((m) => m.content.trim());

  const nb = getActiveNotebook();

  try {
    const res = await api.chatSuggestions({
      messages: history,
      notebookTitle: nb?.title || '',
      scenario: includeScenario ? state.activeCabin : null,
      sessionId: getActiveSessionId(),
    });
    if (seq !== suggestionsSeq) return;
    if (res?.available && Array.isArray(res.queries) && res.queries.length > 0) {
      renderQuickPrompts(res.queries);
    } else {
      hideQuickPrompts();
    }
  } catch {
    if (seq === suggestionsSeq) hideQuickPrompts();
  }
}

function updateScenarioContextPreview() {
  const el = document.getElementById('chat-scenario-preview');
  if (!el) return;
  const c = state.activeCabin;
  el.textContent = includeScenario
    ? `${c.oxygen_pct}% O₂ · ${c.pressure_kpa} kPa · ${c.flow_velocity_cm_s} cm/s · ${c.gravity_g}g · ${c.fuel_material} (${c.diluent_gas})`
    : 'Scenario disabled';
}

export async function sendMessage(text) {
  if (isStreaming || !text.trim()) return;
  isStreaming = true;

  // Ensure isolated target (notebook stays strictly inside notebook; global starts/uses recent chat)
  ensureActiveThreadForSend(text);
  const activeSessionId = getActiveSessionId();

  const dockSendBtn = document.getElementById('mi-send-btn');
  const msgs = document.getElementById('chat-messages');
  if (dockSendBtn) dockSendBtn.disabled = true;

  // Clear empty-state banner on first real message
  if (getActiveMessages().length === 0 && msgs) {
    msgs.innerHTML = '';
  }

  appendMessageToActiveThread({ role: 'user', content: text });

  // User message
  const userRow = document.createElement('div');
  userRow.className = 'msg-row user';
  userRow.innerHTML = `<div class="msg-bubble">${esc(text)}</div>`;
  msgs.appendChild(userRow);

  // Assistant placeholder
  const asstRow = document.createElement('div');
  asstRow.className = 'msg-row assistant';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = `<div class="mono text-muted" style="font-size:12px;">Querying ${esc(activeSessionId)}...</div>`;
  const chartSlot = document.createElement('div');
  const auditSlot = document.createElement('div');
  asstRow.appendChild(bubble);
  asstRow.appendChild(chartSlot);
  asstRow.appendChild(auditSlot);
  msgs.appendChild(asstRow);
  msgs.scrollTop = msgs.scrollHeight;

  let fullText = '';
  let sourcesData = [];
  let streamOutOfScope = false;
  let streamProvider = '';
  let lastAuditData = null;
  let lastChartData = null;

  try {
    await api.streamChat(
      {
        message: text,
        scenario: includeScenario ? state.activeCabin : null,
        sessionId: activeSessionId,
      },
      {
        sources: (data) => {
          sourcesData = data.sources || [];
          streamOutOfScope = Boolean(data.out_of_scope);
          if (!fullText) {
            const kgCount = Number.isFinite(data.kg_fact_count) ? data.kg_fact_count : 0;
            bubble.innerHTML = `<div class="mono text-muted" style="font-size:12px;">${sourcesData.length} chunks · ${kgCount} KG links...</div>`;
          }
        },
        chart: (data) => {
          if (data?.image_base64) {
            lastChartData = data;
            const imgSrc = data.image_base64.startsWith('data:')
              ? data.image_base64
              : `data:image/png;base64,${data.image_base64}`;
            chartSlot.innerHTML = `
              <figure style="margin:10px 0 6px;">
                <img class="chat-chart-img" src="${imgSrc}" alt="${esc(data.title || 'Generated NASA Physics Chart')}" />
                ${
                  data.title || data.caption
                    ? `<figcaption style="margin-top:6px;padding:0 2px;">
                        ${data.title ? `<div style="font-weight:600;font-size:12.5px;color:var(--text-primary);">${esc(data.title)}</div>` : ''}
                        ${data.caption ? `<div class="text-sec" style="font-size:11.5px;margin-top:2px;">${esc(data.caption)}</div>` : ''}
                      </figcaption>`
                    : ''
                }
              </figure>
            `;
            msgs.scrollTop = msgs.scrollHeight;
          }
        },
        token: (data) => {
          fullText += data.token ?? data.text ?? '';
          bubble.innerHTML = renderRichMarkdown(fullText);
          msgs.scrollTop = msgs.scrollHeight;
        },
        audit: (data) => {
          lastAuditData = data || {};
          if (typeof data?.out_of_scope === 'boolean') {
            streamOutOfScope = data.out_of_scope;
          }
          if (data?.provider) {
            streamProvider = data.provider;
          }
          renderAuditPanel(auditSlot, lastAuditData, sourcesData, streamOutOfScope, streamProvider);
          msgs.scrollTop = msgs.scrollHeight;
        },
        done: (data) => {
          if (data?.provider) {
            streamProvider = data.provider;
          }
          if (data?.final_answer) {
            fullText = data.final_answer;
            bubble.innerHTML = renderRichMarkdown(fullText);
          } else if (fullText) {
            bubble.innerHTML = renderRichMarkdown(fullText);
          }
          if (lastAuditData) {
            renderAuditPanel(auditSlot, lastAuditData, sourcesData, streamOutOfScope, streamProvider);
          }
          appendMessageToActiveThread({
            role: 'assistant',
            content: fullText,
            sources: sourcesData,
            audit: lastAuditData ? { ...lastAuditData, provider: streamProvider } : null,
            outOfScope: streamOutOfScope,
            chart: lastChartData,
          });
          refreshQuickPrompts();
        },
      }
    );
  } catch (err) {
    bubble.innerHTML = `<span style="color:var(--risk-crit);">Stream error: ${esc(err.message)}</span>`;
  } finally {
    isStreaming = false;
    if (dockSendBtn) dockSendBtn.disabled = false;
    msgs.scrollTop = msgs.scrollHeight;
  }
}

function extractHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'nasa.gov';
  }
}

function renderSourcesBox(sources, oos) {
  if (oos || !sources || !sources.length) return '';

  // Deduplicate external websites by URL
  const websites = [];
  const seenWeb = new Set();
  // Deduplicate bundled NASA PDFs by pdf_url
  const pdfs = [];
  const seenPdf = new Set();

  for (const s of sources) {
    const webUrl = String(s.url || '').trim();
    if (/^https?:\/\//i.test(webUrl) && !seenWeb.has(webUrl)) {
      seenWeb.add(webUrl);
      websites.push({
        title: s.title || extractHostname(webUrl),
        url: webUrl,
        host: extractHostname(webUrl),
        isLive: Boolean(s.is_live),
        docId: s.is_live ? (s.doc_id || null) : null,
        page: s.page || 1,
      });
    }

    const pdfUrl = String(s.pdf_url || (webUrl.startsWith('/papers/') ? webUrl : '')).trim();
    if (pdfUrl.startsWith('/papers/') && !seenPdf.has(pdfUrl)) {
      seenPdf.add(pdfUrl);
      pdfs.push({
        name: s.pdf_name || pdfUrl.split('/').pop(),
        pdfUrl,
        title: s.title || s.doc_id || 'NASA PDF',
        docId: s.doc_id || null,
        page: s.page || 1,
      });
    }
  }

  if (!websites.length && !pdfs.length) return '';

  const webHtml = websites.length
    ? `
      <div class="sources-group">
        <div class="sources-group-label">Websites (${websites.length})</div>
        <div class="sources-link-list">
          ${websites
            .slice(0, 6)
            .map(
              (w) => `
              <span class="source-pdf-wrap">
                <a class="source-link-pill" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer" title="${esc(w.title)} — ${esc(w.url)}">
                  ${w.isLive ? '<span class="source-live-tag">LIVE</span>' : ''}
                  <span class="source-host">${esc(w.host)}</span>
                  <span class="source-title">${esc(w.title)}</span>
                  <span class="source-ext" aria-hidden="true">↗</span>
                </a>
                ${
                  w.isLive && w.docId
                    ? `<button type="button" class="cite-chip" data-doc-id="${esc(w.docId)}" data-doc-page="${esc(w.page)}" title="Read live-synced NASA page">${esc(w.docId)} p.${esc(w.page)}</button>`
                    : ''
                }
              </span>
            `
            )
            .join('')}
        </div>
      </div>
    `
    : '';

  const pdfHtml = pdfs.length
    ? `
      <div class="sources-group">
        <div class="sources-group-label">NASA PDFs (${pdfs.length})</div>
        <div class="sources-link-list">
          ${pdfs
            .slice(0, 6)
            .map(
              (p) => `
              <span class="source-pdf-wrap">
                <a class="source-pdf-pill" href="${esc(p.pdfUrl)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(p.name)}">
                  <span class="source-pdf-tag">PDF</span>
                  <span class="source-title">${esc(p.name)}</span>
                  <span class="source-ext" aria-hidden="true">↗</span>
                </a>
                ${
                  p.docId
                    ? `<button type="button" class="cite-chip" data-doc-id="${esc(p.docId)}" data-doc-page="${esc(p.page)}" title="Open in Document Reader">${esc(p.docId)}${p.page ? ` p.${p.page}` : ''}</button>`
                    : ''
                }
              </span>
            `
            )
            .join('')}
        </div>
      </div>
    `
    : '';

  return `
    <div class="sources-box">
      <div class="sources-box-header">
        <span>Data Sources</span>
        <span class="mono text-muted" style="font-size:10px;">Verified Websites &amp; Bundled NASA PDFs</span>
      </div>
      ${webHtml}
      ${pdfHtml}
    </div>
  `;
}

function renderAuditPanel(slot, auditData, sources, fallbackOos = false, fallbackProvider = '') {
  const cit = auditData?.citations || auditData || {};
  const oos = Boolean(auditData?.out_of_scope ?? fallbackOos);
  const provider = auditData?.provider || fallbackProvider || '';
  const dropped = cit.dropped_claims || [];
  const docCites = cit.verified_doc_citations || [];
  const expCites = cit.verified_exp_citations || [];

  const ratioPct = Math.round(cit.grounding_pct ?? ((cit.verified_ratio ?? 0) * 100));
  const total = cit.checked_sentences ?? cit.total_sentences ?? 0;
  const cited = cit.cited_sentences ?? 0;

  const statusBadge = oos
    ? `<span class="badge risk-MODERATE">Out-of-Scope Safeguard Active</span>`
    : `<span class="badge risk-LOW">Citation Audit: ${ratioPct}% Grounded (${cited}/${total} sentences)</span>`;

  const citeButtons = [
    ...docCites.map(
      (c) => `<button type="button" class="cite-chip" data-doc-id="${esc(c.doc_id)}" data-doc-page="${c.page || 1}">${esc(c.doc_id)}${c.page ? ` p.${c.page}` : ''}</button>`
    ),
    ...expCites.map(
      (eid) => `<button type="button" class="cite-chip exp-chip" data-exp-id="${esc(eid)}">${esc(eid)}</button>`
    ),
  ].join(' ');

  const droppedHtml = dropped.length
    ? `
      <details style="margin-top:8px;">
        <summary style="cursor:pointer;color:var(--risk-mod);font-weight:600;">
          Audit Log: ${dropped.length} uncited / supplementary sentence(s) flagged
        </summary>
        <ul style="margin:6px 0 0;padding-left:18px;color:var(--text-secondary);">
          ${dropped.map((d) => `<li>${esc(d.sentence)} <span class="mono text-muted">(${esc(d.reason)})</span></li>`).join('')}
        </ul>
      </details>
    `
    : '';

  const sourcesBoxHtml = renderSourcesBox(sources, oos);

  slot.innerHTML = `
    ${sourcesBoxHtml}
    <div class="audit-panel">
      <div class="flex items-center justify-between flex-wrap gap-2">
        ${statusBadge}
        <span class="mono text-muted" style="font-size:10.5px;">${esc(provider)}</span>
      </div>
      ${citeButtons ? `<div class="flex flex-wrap gap-2 mt-2">${citeButtons}</div>` : ''}
      ${droppedHtml}
    </div>
  `;
}

/**
 * FlameAI Co-Pilot: Streaming Hybrid Graph-RAG Chat, Active Cabin Scenario Injection,
 * Clickable NASA Citation Chips, EMBER Sentence-Level Audit / Dropped Claims, & Matplotlib Charts.
 */

import { api } from './api.js';
import { emit, esc, on, renderRichMarkdown, state } from './state.js';

let isStreaming = false;
let includeScenario = true;

const QUICK_PROMPTS = [
  {
    label: 'BASS-II Ventilation Paradox + Plot',
    prompt: 'Explain the BASS-II ventilation paradox in microgravity and plot the LOI shift curve.',
  },
  {
    label: 'Evaluate My Active Cabin',
    prompt: 'Evaluate my active spacecraft cabin configuration, explain the top Shapley risk drivers, and recommend NASA-backed mitigations.',
  },
  {
    label: 'FLEX-2 Cool Flames',
    prompt: 'What are FLEX-2 cool flames, why are they hazardous to spacecraft crews, and how should post-suppression monitoring handle them?',
  },
  {
    label: 'Artemis 34% O₂ PMMA Risk',
    prompt: 'Compare PMMA flammability under ISS 21% O2 vs Artemis 34% O2 / 56.5 kPa exploration atmospheres and chart the material LOI comparison.',
  },
  {
    label: 'NASA Challenge Brief',
    prompt: 'What is the Flame in Freefall NASA Space Apps Challenge brief, objectives, and expected impact?',
  },
  {
    label: 'Out-of-Scope Safeguard Test',
    prompt: 'How do I bake a chocolate cake at sea level?',
  },
];

export function initChat() {
  renderQuickPrompts();
  updateScenarioContextPreview();

  const sendBtn = document.getElementById('chat-send-btn');
  const input = document.getElementById('chat-input');
  const clearBtn = document.getElementById('chat-clear-btn');
  const scenarioToggle = document.getElementById('chat-include-scenario');

  if (scenarioToggle) {
    scenarioToggle.checked = includeScenario;
    scenarioToggle.addEventListener('change', () => {
      includeScenario = scenarioToggle.checked;
      updateScenarioContextPreview();
    });
  }

  sendBtn?.addEventListener('click', () => {
    const text = input?.value?.trim();
    if (text) sendMessage(text);
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (text) sendMessage(text);
    }
  });

  clearBtn?.addEventListener('click', async () => {
    try {
      await api.clearMemory();
    } catch {
      // ignore
    }
    const msgs = document.getElementById('chat-messages');
    if (msgs) {
      msgs.innerHTML = '';
      appendWelcomeMessage();
    }
  });

  on('cabin:changed', updateScenarioContextPreview);
  on('cabin:pill-refresh', updateScenarioContextPreview);

  on('chat:ask', (question) => {
    emit('navigate', 'chat');
    if (question) sendMessage(question);
  });

  appendWelcomeMessage();
}

function appendWelcomeMessage() {
  const msgs = document.getElementById('chat-messages');
  if (!msgs || msgs.children.length > 0) return;
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.innerHTML = `
    <div class="msg-bubble">
      <div class="flex items-center gap-2 mb-3">
        <span class="badge badge-flame">FlameAI v3.0</span>
        <span class="badge badge-cyan">Hybrid Graph-RAG + Citation Audit</span>
      </div>
      <p>Welcome to <strong>FlameAI Co-Pilot</strong>. Ask anything about NASA microgravity combustion, spacecraft fire safety (BASS-II, SAFFIRE, FLEX-2, SoFIE, ACME), Artemis 34% O₂ cabin atmospheres, or request a scientific <strong>plot/chart</strong>.</p>
      <p class="text-sec" style="font-size:12.5px;margin-bottom:0;">Every factual claim is audited against our NASA corpus — click any <button type="button" class="cite-chip" data-doc-id="DOC-01" data-doc-page="1">DOC-01 p.1</button> or <button type="button" class="cite-chip exp-chip" data-exp-id="EXP-0023">EXP-0023</button> badge to inspect the primary evidence.</p>
    </div>
  `;
  msgs.appendChild(row);
}

function renderQuickPrompts() {
  const wrap = document.getElementById('chat-quick-prompts');
  if (!wrap) return;
  wrap.innerHTML = QUICK_PROMPTS.map(
    (p, i) => `
      <button type="button" class="pill-btn" data-qidx="${i}" style="text-align:left;width:100%;">
        ${esc(p.label)}
      </button>
    `
  ).join('');

  wrap.querySelectorAll('[data-qidx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = QUICK_PROMPTS[Number(btn.dataset.qidx)];
      if (item) sendMessage(item.prompt);
    });
  });
}

function updateScenarioContextPreview() {
  const el = document.getElementById('chat-scenario-preview');
  if (!el) return;
  const c = state.activeCabin;
  el.textContent = includeScenario
    ? `${c.oxygen_pct}% O₂ · ${c.pressure_kpa} kPa · ${c.flow_velocity_cm_s} cm/s · ${c.gravity_g}g · ${c.fuel_material} (${c.diluent_gas})`
    : 'Scenario injection disabled — general NASA corpus Q&A mode';
}

export async function sendMessage(text) {
  if (isStreaming || !text.trim()) return;
  isStreaming = true;

  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const msgs = document.getElementById('chat-messages');
  if (input) input.value = '';
  if (sendBtn) sendBtn.disabled = true;

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
  bubble.innerHTML = `<div class="mono text-muted" style="font-size:12px;">Retrieving NASA knowledge graph & hybrid corpus evidence...</div>`;
  const chartSlot = document.createElement('div');
  const auditSlot = document.createElement('div');
  asstRow.appendChild(bubble);
  asstRow.appendChild(chartSlot);
  asstRow.appendChild(auditSlot);
  msgs.appendChild(asstRow);
  msgs.scrollTop = msgs.scrollHeight;

  let fullText = '';
  let sourcesData = [];

  try {
    await api.streamChat(
      { message: text, scenario: includeScenario ? state.activeCabin : null },
      {
        sources: (data) => {
          sourcesData = data.sources || [];
          if (!fullText) {
            bubble.innerHTML = `<div class="mono text-muted" style="font-size:12px;">Retrieved ${sourcesData.length} NASA evidence chunks & ${data.kg_fact_count || 0} KG links — synthesizing...</div>`;
          }
        },
        chart: (data) => {
          if (data.image_base64) {
            chartSlot.innerHTML = `
              <img class="chat-chart-img" src="data:image/png;base64,${data.image_base64}" alt="Generated NASA Physics Chart" />
            `;
            msgs.scrollTop = msgs.scrollHeight;
          }
        },
        token: (data) => {
          fullText += data.text || '';
          bubble.innerHTML = renderRichMarkdown(fullText);
          msgs.scrollTop = msgs.scrollHeight;
        },
        audit: (data) => {
          renderAuditPanel(auditSlot, data, sourcesData);
          msgs.scrollTop = msgs.scrollHeight;
        },
        done: (data) => {
          if (data.final_answer) {
            bubble.innerHTML = renderRichMarkdown(data.final_answer);
          }
        },
      }
    );
  } catch (err) {
    bubble.innerHTML = `<span style="color:var(--risk-crit);">Stream error: ${esc(err.message)}</span>`;
  } finally {
    isStreaming = false;
    if (sendBtn) sendBtn.disabled = false;
    msgs.scrollTop = msgs.scrollHeight;
  }
}

function renderAuditPanel(slot, auditData, sources) {
  const cit = auditData.citations || {};
  const oos = Boolean(auditData.out_of_scope);
  const dropped = cit.dropped_claims || [];
  const docCites = cit.verified_doc_citations || [];
  const expCites = cit.verified_exp_citations || [];

  const ratioPct = Math.round((cit.verified_ratio ?? 1) * 100);
  const statusBadge = oos
    ? `<span class="badge risk-MODERATE">Out-of-Scope Safeguard Active</span>`
    : `<span class="badge risk-LOW">Citation Audit: ${ratioPct}% Grounded (${cit.cited_sentences || 0}/${cit.total_sentences || 0} sentences)</span>`;

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

  const sourcesHtml = !oos && sources.length
    ? `
      <details style="margin-top:6px;">
        <summary style="cursor:pointer;color:var(--text-secondary);">
          Retrieved Evidence (${sources.length} hybrid chunks · ${esc(auditData.provider || '')})
        </summary>
        <div class="flex flex-wrap gap-2 mt-2">
          ${sources
            .slice(0, 6)
            .map((s) => `<span class="badge">${esc(s.doc_id || s.category)}: ${esc(s.title)} (${Math.round((s.score || 0) * 100)}%)</span>`)
            .join('')}
        </div>
      </details>
    `
    : '';

  slot.innerHTML = `
    <div class="audit-panel">
      <div class="flex items-center justify-between flex-wrap gap-2">
        ${statusBadge}
        <span class="mono text-muted" style="font-size:10.5px;">${esc(auditData.provider || '')}</span>
      </div>
      ${citeButtons ? `<div class="flex flex-wrap gap-2 mt-2">${citeButtons}</div>` : ''}
      ${droppedHtml}
      ${sourcesHtml}
    </div>
  `;
}

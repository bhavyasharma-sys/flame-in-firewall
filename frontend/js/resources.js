/**
 * NASA Research Library (Indexed NASA NTRS Papers, ISS Pages, Live-Synced NASA Web Pages,
 * and 9 Bundled NASA Glenn PDFs) + Live NASA Website -> RAG Auto-Sync Control Panel
 * + Global Document Reader Modal (supports clickable [DOC-XX p.Y] & [LIVE-XX p.Y] citations).
 */

import { api } from './api.js';
import { emit, esc, on, state } from './state.js';

let categoryFilter = 'all';
let latestSyncStatus = null;

function formatShortTime(iso) {
  if (!iso) return 'Never';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

async function reloadDocuments() {
  const res = await api.documents();
  state.documents = res.documents || [];
  updateFilterCounts();
  renderResources();
}

function updateFilterCounts() {
  const total = state.documents.length;
  const liveCount = state.documents.filter((d) => d.category === 'live_nasa_web').length;
  const allBtn = document.getElementById('doc-filter-all-btn');
  const liveBtn = document.getElementById('doc-filter-live-btn');
  if (allBtn) allBtn.textContent = `All Documents (${total})`;
  if (liveBtn) liveBtn.textContent = `Live NASA Web (${liveCount})`;
}

async function refreshSyncStatus() {
  try {
    latestSyncStatus = await api.syncStatus();
    renderSyncPanel(latestSyncStatus);
  } catch (err) {
    console.warn('Sync status fetch error:', err);
  }
}

function showSyncFeedback(text, tone = 'info') {
  const el = document.getElementById('sync-feedback-msg');
  if (!el) return;
  el.style.display = text ? 'block' : 'none';
  el.style.color =
    tone === 'error'
      ? 'var(--risk-crit)'
      : tone === 'success'
        ? 'var(--accent-sage)'
        : 'var(--text-secondary)';
  el.textContent = text;
}

function renderSyncPanel(st) {
  if (!st) return;
  const badge = document.getElementById('sync-status-badge');
  const meta = document.getElementById('sync-meta-line');
  const tbody = document.getElementById('sync-sources-list');

  if (badge) {
    if (st.syncing) {
      badge.className = 'badge badge-cyan';
      badge.textContent = 'Syncing NASA websites…';
    } else if (st.live_documents_active > 0) {
      badge.className = 'badge badge-sage';
      badge.textContent = `${st.live_documents_active}/${st.total_watched_sources} Live in RAG`;
    } else if (st.last_run_at) {
      badge.className = 'badge';
      badge.textContent = `Checked ${formatShortTime(st.last_run_at)} · Offline Corpus Ready`;
    } else {
      badge.className = 'badge badge-sage';
      badge.textContent = `Auto-Sync Active (${Math.round((st.interval_seconds || 1800) / 60)}m)`;
    }
  }

  if (meta) {
    const mins = Math.max(1, Math.round((st.interval_seconds || 1800) / 60));
    const digest = st.corpus_digest ? `Digest ${st.corpus_digest}` : 'Indexed';
    const chunks = st.total_chunks ? `${st.total_chunks} RAG chunks` : '';
    const checked = st.last_run_at ? `Last checked ${formatShortTime(st.last_run_at)}` : 'Polling automatically';
    const updated = st.last_update_at ? ` · Last web update ${formatShortTime(st.last_update_at)}` : '';
    meta.innerHTML = `${esc(checked)}${esc(updated)} · Auto-poll every <span class="mono">${mins} min</span> · <span class="mono">${esc(digest)}</span>${chunks ? ` (${esc(chunks)})` : ''}`;
  }

  if (tbody) {
    const rows = st.sources || [];
    tbody.innerHTML = rows
      .map((s) => {
        const statusBadge =
          s.status === 'updated'
            ? '<span class="badge badge-sage">Updated</span>'
            : s.status === 'unchanged'
              ? '<span class="badge badge-cyan">Up to date</span>'
              : s.status === 'unreachable'
                ? `<span class="badge risk-MODERATE" title="${esc(s.error || 'Network unreachable')}">Unreachable</span>`
                : '<span class="badge">Pending</span>';

        return `
          <tr>
            <td class="mono" style="font-weight:700;font-size:11.5px;">${esc(s.doc_id)}</td>
            <td>
              <a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="md-link" style="font-weight:600;font-size:12.5px;">${esc(s.title)}</a>
              <div class="text-muted mono" style="font-size:10.5px;">${esc(s.url)}</div>
            </td>
            <td>${statusBadge}</td>
            <td class="mono">${esc(s.page_count || 0)}</td>
            <td class="mono text-muted" style="font-size:11px;">${esc(formatShortTime(s.last_checked_at))}</td>
            <td>
              <div class="flex gap-2">
                ${
                  s.page_count > 0
                    ? `<button type="button" class="btn btn-sm" data-read-live="${esc(s.doc_id)}">Read</button>`
                    : ''
                }
                <button type="button" class="btn btn-sm" data-sync-one="${esc(s.doc_id)}">Sync</button>
                ${
                  !s.builtin
                    ? `<button type="button" class="btn btn-sm" data-remove-live="${esc(s.doc_id)}" title="Stop watching">✕</button>`
                    : ''
                }
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll('[data-read-live]').forEach((btn) => {
      btn.addEventListener('click', () => openDocumentReader(btn.dataset.readLive, 1));
    });
    tbody.querySelectorAll('[data-sync-one]').forEach((btn) => {
      btn.addEventListener('click', () => runLiveSync({ force: true, doc_id: btn.dataset.syncOne }));
    });
    tbody.querySelectorAll('[data-remove-live]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api.removeSyncSource(btn.dataset.removeLive);
          showSyncFeedback(`Removed ${btn.dataset.removeLive} and refreshed the RAG index.`, 'info');
          await Promise.all([refreshSyncStatus(), reloadDocuments()]);
        } catch (err) {
          showSyncFeedback(`Remove failed: ${err.message}`, 'error');
        }
      });
    });
  }
}

async function runLiveSync({ force = false, doc_id = null } = {}) {
  const nowBtn = document.getElementById('btn-sync-nasa-now');
  const forceBtn = document.getElementById('btn-sync-nasa-force');
  if (nowBtn) nowBtn.disabled = true;
  if (forceBtn) forceBtn.disabled = true;
  showSyncFeedback(
    doc_id
      ? `Fetching live update from ${doc_id}…`
      : force
        ? 'Force-refreshing all watched NASA websites and checking for RAG updates…'
        : 'Checking watched NASA websites for updates…',
    'info'
  );

  try {
    const res = await api.syncNasaNow({ force, doc_id });
    if (res.status) {
      latestSyncStatus = {
        ...res.status,
        corpus_digest: res.corpus_digest_after,
        total_chunks: res.total_chunks,
      };
      renderSyncPanel(latestSyncStatus);
    }
    await reloadDocuments();

    if (res.rag_rebuilt) {
      showSyncFeedback(
        `Synced in ${res.duration_ms} ms — ${res.updated_count} NASA source(s) updated (${(res.updated_ids || []).join(', ')}). RAG pipeline rebuilt (${res.total_chunks} chunks, digest ${res.corpus_digest_after}).`,
        'success'
      );
    } else if (res.unreachable_count === res.checked_count && res.checked_count > 0) {
      showSyncFeedback(
        `Checked ${res.checked_count} NASA source(s) in ${res.duration_ms} ms — outbound NASA access is currently restricted/offline; offline NASA corpus & PDFs remain active (${res.total_chunks} chunks).`,
        'info'
      );
    } else {
      showSyncFeedback(
        `Checked ${res.checked_count} NASA source(s) in ${res.duration_ms} ms — ${res.unchanged_count} up to date, ${res.unreachable_count} unreachable. RAG index unchanged (${res.corpus_digest_after}).`,
        'info'
      );
    }
  } catch (err) {
    showSyncFeedback(`Live NASA sync error: ${err.message}`, 'error');
  } finally {
    if (nowBtn) nowBtn.disabled = false;
    if (forceBtn) forceBtn.disabled = false;
  }
}

export async function initResources() {
  try {
    await Promise.all([reloadDocuments(), refreshSyncStatus()]);
  } catch (err) {
    console.error('Documents load error:', err);
  }

  document.querySelectorAll('[data-doc-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      categoryFilter = btn.dataset.docFilter;
      document.querySelectorAll('[data-doc-filter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderResources();
    });
  });

  document.getElementById('resources-search')?.addEventListener('input', renderResources);

  document.getElementById('btn-sync-nasa-now')?.addEventListener('click', () => runLiveSync({ force: false }));
  document.getElementById('btn-sync-nasa-force')?.addEventListener('click', () => runLiveSync({ force: true }));
  document.getElementById('btn-sync-toggle-list')?.addEventListener('click', () => {
    const drawer = document.getElementById('sync-sources-drawer');
    if (!drawer) return;
    drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
  });

  document.getElementById('sync-add-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const urlInput = document.getElementById('sync-add-url');
    const titleInput = document.getElementById('sync-add-title');
    const addBtn = document.getElementById('btn-sync-add-url');
    const url = (urlInput?.value || '').trim();
    const title = (titleInput?.value || '').trim() || null;
    if (!url) return;

    if (addBtn) addBtn.disabled = true;
    showSyncFeedback(`Adding and syncing ${url} into the RAG pipeline…`, 'info');
    try {
      const res = await api.addSyncSource({ url, title, sync_now: true });
      if (urlInput) urlInput.value = '';
      if (titleInput) titleInput.value = '';
      await Promise.all([refreshSyncStatus(), reloadDocuments()]);
      const synced = res.sync;
      if (synced?.rag_rebuilt) {
        showSyncFeedback(
          `Added ${res.source.doc_id} and indexed live content into RAG (${res.total_chunks} chunks, digest ${res.corpus_digest}).`,
          'success'
        );
      } else {
        showSyncFeedback(
          `Registered ${res.source.doc_id} (${res.source.url}) on the NASA watchlist. It will sync automatically whenever reachable.`,
          'info'
        );
      }
    } catch (err) {
      showSyncFeedback(`Could not watch URL: ${err.message}`, 'error');
    } finally {
      if (addBtn) addBtn.disabled = false;
    }
  });
}

function renderResources() {
  const grid = document.getElementById('resources-grid');
  if (!grid) return;
  const q = (document.getElementById('resources-search')?.value || '').trim().toLowerCase();

  const docs = state.documents.filter((d) => {
    if (categoryFilter !== 'all' && d.category !== categoryFilter) return false;
    if (q) {
      const hay = `${d.doc_id} ${d.title} ${d.investigation} ${(d.authors || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!docs.length) {
    grid.innerHTML = `
      <div class="card" style="grid-column:1 / -1;text-align:center;padding:28px;">
        <div class="text-sec" style="font-size:13.5px;">
          ${
            categoryFilter === 'live_nasa_web'
              ? 'No live NASA web pages cached yet — click <strong>Sync NASA Websites</strong> above to pull the latest live pages from *.nasa.gov into the RAG pipeline.'
              : 'No matching NASA documents found for this filter.'
          }
        </div>
      </div>
    `;
    return;
  }

  grid.innerHTML = docs
    .map((d) => {
      const pdfUrl = d.pdf_file ? `/papers/${encodeURIComponent(d.pdf_file)}` : null;
      const isLive = d.category === 'live_nasa_web' || d.is_live;
      const catBadge = isLive
        ? 'badge-sage'
        : d.category === 'iss_investigation'
          ? 'badge-cyan'
          : d.category === 'challenge_brief'
            ? 'badge-violet'
            : 'badge-flame';
      const catLabel = isLive
        ? 'Live NASA Web'
        : d.category === 'iss_investigation'
          ? 'ISS Investigation'
          : d.category === 'challenge_brief'
            ? 'Challenge Brief'
            : 'NASA NTRS Paper';

      return `
        <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;gap:12px;">
          <div>
            <div class="flex items-center justify-between gap-2 mb-3">
              <span class="badge ${catBadge}">${esc(d.doc_id)}</span>
              <span class="badge">${esc(catLabel)} · ${esc(d.year)}</span>
            </div>
            <h3 style="font-family:var(--font-display);font-size:15.5px;margin:0 0 6px;">${esc(d.title)}</h3>
            <div class="text-muted" style="font-size:12px;margin-bottom:8px;">
              ${esc((d.authors || []).join(', ') || 'NASA Research Team')} · ${esc(d.page_count)} pages${
                isLive && d.last_synced_at ? ` · Synced ${esc(formatShortTime(d.last_synced_at))}` : ''
              }
            </div>
            ${
              (d.related_experiment_ids || []).length
                ? `<div class="flex flex-wrap gap-2">
                    ${d.related_experiment_ids.slice(0, 4).map((eid) => `<button type="button" class="cite-chip exp-chip" data-exp-id="${esc(eid)}">${esc(eid)}</button>`).join('')}
                  </div>`
                : ''
            }
          </div>

          <div class="flex items-center gap-2 flex-wrap" style="border-top:1px solid var(--border-subtle);padding-top:10px;">
            <button type="button" class="btn btn-primary btn-sm" data-read-doc="${esc(d.doc_id)}">Read Full Text</button>
            ${
              pdfUrl
                ? `<a class="btn btn-cyan btn-sm" href="${pdfUrl}" target="_blank" rel="noopener">Open NASA PDF ↗</a>`
                : ''
            }
            ${
              d.source_url
                ? `<a class="btn btn-sm" href="${esc(d.source_url)}" target="_blank" rel="noopener">NASA Source ↗</a>`
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');

  grid.querySelectorAll('[data-read-doc]').forEach((btn) => {
    btn.addEventListener('click', () => openDocumentReader(btn.dataset.readDoc, 1));
  });
}

export async function openDocumentReader(docId, highlightPage = 1) {
  try {
    const doc = await api.documentDetail(docId);
    const pdfUrl = doc.pdf_file ? `/papers/${encodeURIComponent(doc.pdf_file)}` : null;

    const pagesHtml = (doc.pages || [])
      .map(
        (p) => `
        <div class="doc-page-card ${Number(p.page) === Number(highlightPage) ? 'highlight-page' : ''}" id="doc-reader-p-${p.page}">
          <div class="flex items-center justify-between gap-2 mb-3">
            <span class="badge badge-cyan">Page ${p.page}</span>
            <span class="mono text-muted" style="font-size:11px;">${esc(p.section || '')}</span>
          </div>
          <div>${esc(p.text)}</div>
        </div>
      `
      )
      .join('');

    const headerActions = `
      <div class="flex flex-wrap gap-2 mb-3">
        <span class="badge ${doc.is_live ? 'badge-sage' : 'badge-flame'}">${esc(doc.doc_id)}</span>
        <span class="badge">${esc(doc.investigation || 'NASA')}</span>
        <span class="badge">${esc(doc.year)}</span>
        ${doc.is_live && doc.last_synced_at ? `<span class="badge badge-sage">Live Synced ${esc(formatShortTime(doc.last_synced_at))}</span>` : ''}
        ${pdfUrl ? `<a class="btn btn-cyan btn-sm" href="${pdfUrl}" target="_blank" rel="noopener">Download / Open Original NASA PDF ↗</a>` : ''}
        ${doc.source_url ? `<a class="btn btn-sm" href="${esc(doc.source_url)}" target="_blank" rel="noopener">NASA Source ↗</a>` : ''}
      </div>
      ${
        (doc.related_experiment_ids || []).length
          ? `<div class="flex items-center flex-wrap gap-2 mb-3">
              <span class="mono text-muted" style="font-size:11px;">LINKED TEST RUNS:</span>
              ${doc.related_experiment_ids.map((eid) => `<button type="button" class="cite-chip exp-chip" data-exp-id="${esc(eid)}">${esc(eid)}</button>`).join('')}
            </div>`
          : ''
      }
      ${pagesHtml}
    `;

    emit('modal:open', {
      title: doc.title,
      subtitle: `${(doc.authors || []).join(', ')} · ${doc.page_count} page(s)`,
      bodyHtml: headerActions,
      scrollToId: `doc-reader-p-${highlightPage}`,
    });
  } catch (err) {
    console.error('Document reader error:', err);
  }
}

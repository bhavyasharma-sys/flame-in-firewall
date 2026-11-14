/**
 * NASA Research Library (13 Full-Text Documents + 9 Bundled NASA Glenn PDFs)
 * and Global Document Reader Modal (supports clickable [DOC-XX p.Y] citations).
 */

import { api } from './api.js';
import { emit, esc, on, state } from './state.js';

let categoryFilter = 'all';

export async function initResources() {
  try {
    const res = await api.documents();
    state.documents = res.documents || [];
    renderResources();
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

  on('doc:open', ({ docId, page }) => openDocumentReader(docId, page || 1));
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

  grid.innerHTML = docs
    .map((d) => {
      const pdfUrl = d.pdf_file ? `/papers/${encodeURIComponent(d.pdf_file)}` : null;
      const catBadge =
        d.category === 'iss_investigation'
          ? 'badge-cyan'
          : d.category === 'challenge_brief'
            ? 'badge-violet'
            : 'badge-flame';
      const catLabel =
        d.category === 'iss_investigation'
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
              ${esc((d.authors || []).join(', ') || 'NASA Research Team')} · ${esc(d.page_count)} pages
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
        <span class="badge badge-flame">${esc(doc.doc_id)}</span>
        <span class="badge">${esc(doc.investigation || 'NASA')}</span>
        <span class="badge">${esc(doc.year)}</span>
        ${pdfUrl ? `<a class="btn btn-cyan btn-sm" href="${pdfUrl}" target="_blank" rel="noopener">Download / Open Original NASA PDF ↗</a>` : ''}
        ${doc.source_url ? `<a class="btn btn-sm" href="${esc(doc.source_url)}" target="_blank" rel="noopener">NASA NTRS Link ↗</a>` : ''}
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

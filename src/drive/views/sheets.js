// In-app Google Sheets editor: an editable grid backed by the values API.
//
// Edits are written per changed cell with valueInputOption=USER_ENTERED, so
// typing "=SUM(A1:A5)" or "1/2/2026" behaves the way it does in Sheets.

import { icon } from '../../icons.js';
import { esc } from '../../util.js';
import { sheetsApi } from '../api.js';
import { toast } from '../../actions.js';
import { columnLetter } from '../util.js';

const MIN_ROWS = 50;
const MIN_COLS = 12;
const MAX_ROWS = 500;
const MAX_COLS = 40;

const model = {
  fileId: null,
  title: '',
  sheets: [],
  activeSheet: null,
  values: [],
  rows: MIN_ROWS,
  cols: MIN_COLS,
  active: { row: 0, col: 0 },
  dirty: new Set(),
  saving: false,
  savedAt: null
};

function cellValue(row, col) {
  const line = model.values[row];
  return (line && line[col] !== undefined && line[col] !== null) ? String(line[col]) : '';
}

function setCellValue(row, col, value) {
  while (model.values.length <= row) model.values.push([]);
  const line = model.values[row];
  while (line.length <= col) line.push('');
  line[col] = value;
}

function statusText() {
  if (model.saving) return 'Saving…';
  if (model.dirty.size) return 'Unsaved changes';
  if (model.savedAt) return 'All changes saved';
  return '';
}

function toolbar() {
  const { row, col } = model.active;
  return `
    <div class="dr-sheet-toolbar">
      <span class="dr-sheet-ref">${esc(columnLetter(col) + (row + 1))}</span>
      <input class="dr-sheet-formula" id="dr-sheet-formula" value="${esc(cellValue(row, col))}"
             spellcheck="false" aria-label="Cell contents">
      <span class="dr-sheet-status">${esc(statusText())}</span>
      <button class="dr-btn dr-btn-primary" data-sheet-action="save" ${model.dirty.size ? '' : 'disabled'}>
        ${icon('save', { size: 18 })}<span>Save</span>
      </button>
    </div>`;
}

function grid() {
  const header = ['<th class="dr-sheet-corner"></th>'];
  for (let c = 0; c < model.cols; c++) {
    header.push(`<th class="dr-sheet-colhead${model.active.col === c ? ' is-active' : ''}">${columnLetter(c)}</th>`);
  }

  const body = [];
  for (let r = 0; r < model.rows; r++) {
    const cells = [`<th class="dr-sheet-rowhead${model.active.row === r ? ' is-active' : ''}">${r + 1}</th>`];
    for (let c = 0; c < model.cols; c++) {
      const isActive = model.active.row === r && model.active.col === c;
      const key = `${r}:${c}`;
      cells.push(
        `<td class="dr-sheet-cell${isActive ? ' is-active' : ''}${model.dirty.has(key) ? ' is-dirty' : ''}"
             data-row="${r}" data-col="${c}" contenteditable="true"
             spellcheck="false">${esc(cellValue(r, c))}</td>`
      );
    }
    body.push(`<tr>${cells.join('')}</tr>`);
  }

  return `<div class="dr-sheet-scroll">
    <table class="dr-sheet-grid">
      <thead><tr>${header.join('')}</tr></thead>
      <tbody>${body.join('')}</tbody>
    </table>
  </div>`;
}

function tabs() {
  if (model.sheets.length < 2) return '';
  return `<div class="dr-sheet-tabs">
    ${model.sheets.map(sheet => `
      <button class="dr-sheet-tab${model.activeSheet === sheet.title ? ' is-active' : ''}"
              data-sheet-title="${esc(sheet.title)}">${esc(sheet.title)}</button>`).join('')}
  </div>`;
}

function paint(host) {
  host.innerHTML = `<div class="dr-sheet">${toolbar()}${grid()}${tabs()}</div>`;
}

async function loadSheet(title) {
  const range = `'${String(title).replace(/'/g, "''")}'!A1:${columnLetter(MAX_COLS - 1)}${MAX_ROWS}`;
  const data = await sheetsApi.values(model.fileId, range);
  model.values = (data.values || []).map(row => row.slice());
  model.activeSheet = title;
  model.rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, model.values.length + 10));
  model.cols = Math.max(MIN_COLS, Math.min(MAX_COLS,
    model.values.reduce((max, row) => Math.max(max, row.length), 0) + 3));
  model.dirty.clear();
}

/** Write every dirty cell back, one range per cell. */
async function save(host) {
  if (!model.dirty.size || model.saving) return;
  model.saving = true;
  paint(host);

  const entries = Array.from(model.dirty);
  const prefix = `'${String(model.activeSheet).replace(/'/g, "''")}'!`;

  try {
    for (const key of entries) {
      const [row, col] = key.split(':').map(Number);
      const range = `${prefix}${columnLetter(col)}${row + 1}`;
      await sheetsApi.setValues(model.fileId, range, [[cellValue(row, col)]]);
      model.dirty.delete(key);
    }
    model.savedAt = Date.now();
    toast('Changes saved to Google Sheets');
  } catch (err) {
    toast(`Could not save: ${err.message}`);
  } finally {
    model.saving = false;
    paint(host);
  }
}

/**
 * Mount the editor into the viewer body.
 * @param {HTMLElement} host
 * @param {object} file Drive file for the spreadsheet
 */
export async function mountSheetsEditor(host, file) {
  model.fileId = file.id;
  model.dirty.clear();
  model.savedAt = null;
  model.active = { row: 0, col: 0 };
  host.innerHTML = '<div class="dr-progress" role="progressbar"></div>';

  try {
    const meta = await sheetsApi.meta(file.id);
    model.title = (meta.properties && meta.properties.title) || file.name;
    model.sheets = (meta.sheets || []).map(s => ({
      title: s.properties.title,
      index: s.properties.index
    }));
    if (!model.sheets.length) model.sheets = [{ title: 'Sheet1', index: 0 }];

    await loadSheet(model.sheets[0].title);
    paint(host);
    bind(host);
  } catch (err) {
    host.innerHTML = `<div class="dr-viewer-fallback">
      ${icon('report', { size: 64 })}
      <h3>Could not open the spreadsheet</h3>
      <p>${esc(err.message)}</p>
      <p class="dr-viewer-hint">This needs the Google Sheets app connected in Maton, not just Drive.</p>
    </div>`;
  }
}

function bind(host) {
  if (host.dataset.sheetsBound === 'true') return;
  host.dataset.sheetsBound = 'true';

  host.addEventListener('focusin', event => {
    const cell = event.target.closest('.dr-sheet-cell');
    if (!cell) return;
    model.active = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
    const formula = host.querySelector('#dr-sheet-formula');
    const ref = host.querySelector('.dr-sheet-ref');
    if (formula) formula.value = cell.textContent;
    if (ref) ref.textContent = columnLetter(model.active.col) + (model.active.row + 1);
  });

  host.addEventListener('focusout', event => {
    const cell = event.target.closest('.dr-sheet-cell');
    if (!cell) return;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const next = cell.textContent.replace(/ /g, ' ').trim();
    if (next === cellValue(row, col)) return;

    setCellValue(row, col, next);
    model.dirty.add(`${row}:${col}`);
    cell.classList.add('is-dirty');
    const status = host.querySelector('.dr-sheet-status');
    if (status) status.textContent = statusText();
    const saveBtn = host.querySelector('[data-sheet-action="save"]');
    if (saveBtn) saveBtn.disabled = false;
  });

  host.addEventListener('keydown', event => {
    const cell = event.target.closest('.dr-sheet-cell');
    if (!cell) return;

    // Enter commits and drops down; Tab commits and moves right.
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    let target = null;

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      target = { row: Math.min(row + 1, model.rows - 1), col };
    } else if (event.key === 'Tab') {
      event.preventDefault();
      target = event.shiftKey
        ? { row, col: Math.max(col - 1, 0) }
        : { row, col: Math.min(col + 1, model.cols - 1) };
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cell.textContent = cellValue(row, col);
      cell.blur();
      return;
    }

    if (target) {
      cell.blur();
      const next = host.querySelector(`.dr-sheet-cell[data-row="${target.row}"][data-col="${target.col}"]`);
      if (next) next.focus();
    }
    event.stopPropagation();
  });

  host.addEventListener('click', async event => {
    const saveBtn = event.target.closest('[data-sheet-action="save"]');
    if (saveBtn) return save(host);

    const tab = event.target.closest('[data-sheet-title]');
    if (tab && tab.dataset.sheetTitle !== model.activeSheet) {
      if (model.dirty.size && !confirm('You have unsaved changes. Switch sheets and discard them?')) return;
      host.innerHTML = '<div class="dr-progress" role="progressbar"></div>';
      try {
        await loadSheet(tab.dataset.sheetTitle);
        model.active = { row: 0, col: 0 };
        paint(host);
      } catch (err) {
        toast(err.message);
      }
    }
  });

  // Typing in the formula bar writes through to the active cell.
  host.addEventListener('change', event => {
    if (event.target.id !== 'dr-sheet-formula') return;
    const { row, col } = model.active;
    setCellValue(row, col, event.target.value);
    model.dirty.add(`${row}:${col}`);
    const cell = host.querySelector(`.dr-sheet-cell[data-row="${row}"][data-col="${col}"]`);
    if (cell) {
      cell.textContent = event.target.value;
      cell.classList.add('is-dirty');
    }
    const saveBtn = host.querySelector('[data-sheet-action="save"]');
    if (saveBtn) saveBtn.disabled = false;
  });
}

export function sheetsHasUnsavedChanges() {
  return model.dirty.size > 0;
}

// In-app Google Docs editor.
//
// The Docs API models a document as index-addressed content, not HTML, so:
//   load  — walk body.content into paragraphs of styled runs, render as HTML
//   save  — delete the whole body, re-insert the text, then re-apply the
//           style runs by index
//
// That round trip preserves text, paragraph breaks and bold/italic/underline.
// Structural features it does not model — tables, images, lists, headings,
// links — survive in the document only if left untouched, so the editor
// refuses to save when it detects them rather than silently dropping them.

import { icon } from '../../icons.js';
import { esc } from '../../util.js';
import { docsApi } from '../api.js';
import { toast } from '../../actions.js';

const model = {
  fileId: null,
  title: '',
  paragraphs: [],
  unsupported: [],
  dirty: false,
  saving: false,
  savedAt: null
};

const STYLE_TAGS = [
  { key: 'bold', tag: 'strong' },
  { key: 'italic', tag: 'em' },
  { key: 'underline', tag: 'u' }
];

// --- Load -------------------------------------------------------------------

function readDocument(doc) {
  const paragraphs = [];
  const unsupported = new Set();

  (doc.body && doc.body.content ? doc.body.content : []).forEach(element => {
    if (element.table) unsupported.add('tables');
    if (element.sectionBreak && paragraphs.length) unsupported.add('section breaks');
    if (element.tableOfContents) unsupported.add('a table of contents');
    if (!element.paragraph) return;

    const paragraph = element.paragraph;
    if (paragraph.bullet) unsupported.add('lists');

    const runs = [];
    (paragraph.elements || []).forEach(part => {
      if (part.inlineObjectElement) { unsupported.add('images'); return; }
      if (!part.textRun) return;

      const style = part.textRun.textStyle || {};
      if (style.link) unsupported.add('links');
      // Docs terminates every paragraph with a newline that is not content.
      const text = String(part.textRun.content || '').replace(/\n$/, '');
      if (!text) return;

      runs.push({
        text,
        bold: !!style.bold,
        italic: !!style.italic,
        underline: !!style.underline
      });
    });

    const named = paragraph.paragraphStyle && paragraph.paragraphStyle.namedStyleType;
    if (named && named !== 'NORMAL_TEXT') unsupported.add('headings');

    paragraphs.push({ runs });
  });

  return { paragraphs, unsupported: Array.from(unsupported) };
}

function runToHtml(run) {
  let html = esc(run.text);
  STYLE_TAGS.forEach(({ key, tag }) => {
    if (run[key]) html = `<${tag}>${html}</${tag}>`;
  });
  return html;
}

function documentToHtml(paragraphs) {
  if (!paragraphs.length) return '<p><br></p>';
  return paragraphs
    .map(p => `<p>${p.runs.map(runToHtml).join('') || '<br>'}</p>`)
    .join('');
}

// --- Read back from the editor ---------------------------------------------

/** Walk the contenteditable DOM back into paragraphs of styled runs. */
function htmlToParagraphs(root) {
  const paragraphs = [];

  const walkInline = (node, style, runs) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue.replace(/ /g, ' ');
      if (text) runs.push({ text, ...style });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();
    if (tag === 'br') { runs.push({ text: '\v', ...style }); return; }

    const next = {
      bold: style.bold || tag === 'b' || tag === 'strong',
      italic: style.italic || tag === 'i' || tag === 'em',
      underline: style.underline || tag === 'u'
    };
    node.childNodes.forEach(child => walkInline(child, next, runs));
  };

  const blocks = root.querySelectorAll('p, div');
  const sources = blocks.length ? Array.from(blocks) : [root];

  sources.forEach(block => {
    // Skip wrappers that only contain other blocks.
    if (block.querySelector('p, div')) return;
    const runs = [];
    block.childNodes.forEach(child =>
      walkInline(child, { bold: false, italic: false, underline: false }, runs));
    paragraphs.push({ runs: runs.filter(r => r.text) });
  });

  return paragraphs.length ? paragraphs : [{ runs: [] }];
}

/**
 * Build the batchUpdate requests that replace the document body.
 * Indices are 1-based and every paragraph contributes a trailing newline.
 */
function buildSaveRequests(paragraphs, endIndex) {
  const requests = [];

  // Docs will not let the final newline of the body be deleted.
  if (endIndex > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }

  const text = paragraphs
    .map(p => p.runs.map(r => r.text.replace(/\v/g, '\n')).join(''))
    .join('\n');

  if (!text) return requests;

  requests.push({ insertText: { location: { index: 1 }, text } });

  // Re-apply styling by walking the same offsets the text was built from.
  let cursor = 1;
  paragraphs.forEach((paragraph, pIndex) => {
    paragraph.runs.forEach(run => {
      const length = run.text.replace(/\v/g, '\n').length;
      if (length && (run.bold || run.italic || run.underline)) {
        requests.push({
          updateTextStyle: {
            range: { startIndex: cursor, endIndex: cursor + length },
            textStyle: {
              bold: !!run.bold,
              italic: !!run.italic,
              underline: !!run.underline
            },
            fields: 'bold,italic,underline'
          }
        });
      }
      cursor += length;
    });
    if (pIndex < paragraphs.length - 1) cursor += 1; // the joining newline
  });

  return requests;
}

// --- Rendering --------------------------------------------------------------

function statusText() {
  if (model.saving) return 'Saving…';
  if (model.dirty) return 'Unsaved changes';
  if (model.savedAt) return 'All changes saved';
  return '';
}

function toolbar() {
  const button = (command, iconName, title) =>
    `<button class="dr-icon-btn dr-doc-tool" data-doc-command="${command}" title="${esc(title)}">
       ${icon(iconName, { size: 18 })}
     </button>`;

  return `
    <div class="dr-doc-toolbar">
      ${button('bold', 'bold', 'Bold (Ctrl+B)')}
      ${button('italic', 'italic', 'Italic (Ctrl+I)')}
      ${button('underline', 'underline', 'Underline (Ctrl+U)')}
      <span class="dr-toolbar-divider"></span>
      ${button('undo', 'undo', 'Undo')}
      ${button('redo', 'redo', 'Redo')}
      <span class="dr-doc-status">${esc(statusText())}</span>
      <button class="dr-btn dr-btn-primary" data-doc-action="save" ${model.dirty ? '' : 'disabled'}>
        ${icon('save', { size: 18 })}<span>Save</span>
      </button>
    </div>`;
}

function warningBanner() {
  if (!model.unsupported.length) return '';
  return `<div class="dr-doc-warning">
    ${icon('report', { size: 18 })}
    <span>This document contains ${esc(model.unsupported.join(', '))}, which this editor
    cannot represent. Editing is allowed but saving is disabled so nothing is lost —
    use “Open in Google Docs” to change it.</span>
  </div>`;
}

function paint(host) {
  const blocked = model.unsupported.length > 0;
  host.innerHTML = `
    <div class="dr-doc">
      ${blocked ? '' : toolbar()}
      ${warningBanner()}
      <div class="dr-doc-page">
        <div class="dr-doc-body" id="dr-doc-body" contenteditable="${blocked ? 'false' : 'true'}"
             role="textbox" aria-multiline="true" aria-label="Document body"
             spellcheck="true">${documentToHtml(model.paragraphs)}</div>
      </div>
    </div>`;
}

// --- Save -------------------------------------------------------------------

async function save(host) {
  if (model.saving || model.unsupported.length) return;
  const body = host.querySelector('#dr-doc-body');
  if (!body) return;

  model.saving = true;
  paint(host);

  try {
    // Re-read the document to get an end index that matches the server.
    const current = await docsApi.get(model.fileId);
    const content = (current.body && current.body.content) || [];
    const endIndex = content.length ? content[content.length - 1].endIndex : 2;

    const paragraphs = htmlToParagraphs(body);
    const requests = buildSaveRequests(paragraphs, endIndex);
    if (requests.length) await docsApi.batchUpdate(model.fileId, requests);

    model.paragraphs = paragraphs;
    model.dirty = false;
    model.savedAt = Date.now();
    toast('Changes saved to Google Docs');
  } catch (err) {
    toast(`Could not save: ${err.message}`);
  } finally {
    model.saving = false;
    paint(host);
  }
}

// --- Mount ------------------------------------------------------------------

export async function mountDocsEditor(host, file) {
  model.fileId = file.id;
  model.dirty = false;
  model.savedAt = null;
  host.innerHTML = '<div class="dr-progress" role="progressbar"></div>';

  try {
    const doc = await docsApi.get(file.id);
    model.title = doc.title || file.name;
    const parsed = readDocument(doc);
    model.paragraphs = parsed.paragraphs;
    model.unsupported = parsed.unsupported;
    paint(host);
    bind(host);
  } catch (err) {
    host.innerHTML = `<div class="dr-viewer-fallback">
      ${icon('report', { size: 64 })}
      <h3>Could not open the document</h3>
      <p>${esc(err.message)}</p>
      <p class="dr-viewer-hint">This needs the Google Docs app connected in Maton, not just Drive.</p>
    </div>`;
  }
}

function bind(host) {
  if (host.dataset.docsBound === 'true') return;
  host.dataset.docsBound = 'true';

  host.addEventListener('input', event => {
    if (!event.target.closest('#dr-doc-body')) return;
    if (model.dirty) return;
    model.dirty = true;
    const status = host.querySelector('.dr-doc-status');
    if (status) status.textContent = statusText();
    const saveBtn = host.querySelector('[data-doc-action="save"]');
    if (saveBtn) saveBtn.disabled = false;
  });

  host.addEventListener('click', event => {
    const command = event.target.closest('[data-doc-command]');
    if (command) {
      const body = host.querySelector('#dr-doc-body');
      if (body) body.focus();
      document.execCommand(command.dataset.docCommand, false, null);
      model.dirty = true;
      const saveBtn = host.querySelector('[data-doc-action="save"]');
      if (saveBtn) saveBtn.disabled = false;
      return;
    }
    if (event.target.closest('[data-doc-action="save"]')) save(host);
  });

  host.addEventListener('keydown', event => {
    if (!event.target.closest('#dr-doc-body')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save(host);
    }
    event.stopPropagation();
  });
}

export function docsHasUnsavedChanges() {
  return model.dirty;
}

export { buildSaveRequests, htmlToParagraphs, readDocument, documentToHtml };

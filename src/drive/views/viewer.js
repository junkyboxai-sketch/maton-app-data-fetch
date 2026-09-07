// Two distinct file surfaces, matching Drive's own distinction:
//
//   preview — a dismissible dark overlay for a quick look. Read-only.
//   open    — a full-window surface that replaces the file browser. Docs and
//             Sheets get their real editor here; everything else gets a
//             full-size viewer with its own app bar.
//
// Neither ever navigates to Google. Native Google types have no downloadable
// bytes, so they are exported (Docs/Sheets to HTML, Slides to PDF, Drawings to
// PNG) and rendered in a script-free sandboxed frame.

import { icon } from '../../icons.js';
import { esc } from '../../util.js';
import { driveState } from '../state.js';
import { contentUrl } from '../api.js';
import { fileType, formatFileSize, formatDriveDate, nativeEditor } from '../util.js';

// Fetching a huge text file into a <pre> would lock the tab.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

const FRAME_STYLES = `
  <style>
    html,body{margin:0;padding:0;background:#fff}
    body{font-family:Roboto,Arial,sans-serif;font-size:14px;line-height:1.6;color:#202124;padding:48px 64px}
    img{max-width:100%;height:auto}
    table{border-collapse:collapse;max-width:100%}
    table td,table th{border:1px solid #dadce0;padding:6px 10px;font-size:13px}
    a{color:#1a73e8}
    pre{white-space:pre-wrap;word-wrap:break-word}
    @media (max-width:800px){body{padding:24px}}
  </style>`;

function neighbours(file) {
  const index = driveState.files.findIndex(f => f.id === file.id);
  return {
    hasPrev: index > 0,
    hasNext: index > -1 && index < driveState.files.length - 1
  };
}

// --- Headers ----------------------------------------------------------------

/** Preview: a dark lightbox bar, with Open as the way to escalate. */
function previewBar(file) {
  const type = fileType(file.mimeType);
  const { hasPrev, hasNext } = neighbours(file);

  return `
    <header class="dr-viewer-bar">
      <button class="dr-icon-btn dr-on-dark" data-action="close-viewer" title="Close preview (Esc)">
        ${icon('close', { size: 22 })}
      </button>
      <span class="dr-viewer-icon" style="color:${type.color}">${icon(type.icon, { size: 20 })}</span>
      <span class="dr-viewer-title" title="${esc(file.name)}">${esc(file.name)}</span>
      <span class="dr-viewer-chip">Preview</span>

      <span class="dr-viewer-gap"></span>

      <button class="dr-btn dr-btn-light" data-action="open-full">
        ${icon('openInFull', { size: 18 })}<span>Open</span>
      </button>
      <button class="dr-icon-btn dr-on-dark" data-action="viewer-star"
              title="${file.starred ? 'Remove star' : 'Add star'}">
        ${icon(file.starred ? 'star' : 'starOutline', { size: 22 })}
      </button>
      <a class="dr-icon-btn dr-on-dark" href="${esc(contentUrl(file, false))}"
         download="${esc(file.name)}" title="Download">${icon('download', { size: 22 })}</a>

      <span class="dr-viewer-sep"></span>
      <button class="dr-icon-btn dr-on-dark" data-action="viewer-prev" title="Previous"
              ${hasPrev ? '' : 'disabled'}>${icon('chevronLeft', { size: 22 })}</button>
      <button class="dr-icon-btn dr-on-dark" data-action="viewer-next" title="Next"
              ${hasNext ? '' : 'disabled'}>${icon('chevronRight', { size: 22 })}</button>
    </header>`;
}

/** Open: a light application bar. This is the file's own workspace. */
function openBar(file) {
  const type = fileType(file.mimeType);
  const editor = driveState.editor;

  return `
    <header class="dr-app-bar">
      <button class="dr-icon-btn" data-action="close-viewer" title="Back to Drive">
        ${icon('chevronLeft', { size: 22 })}
      </button>
      <span class="dr-app-icon" style="color:${type.color}">${icon(type.icon, { size: 24 })}</span>
      <div class="dr-app-titles">
        <span class="dr-app-title" title="${esc(file.name)}">${esc(file.name)}</span>
        <span class="dr-app-sub">
          ${esc(type.label)}${editor ? ' · editing in Maton' : ''}
          · ${esc(formatDriveDate(file.modifiedTime))}
        </span>
      </div>

      <span class="dr-viewer-gap"></span>

      <button class="dr-icon-btn" data-action="viewer-star"
              title="${file.starred ? 'Remove star' : 'Add star'}">
        ${icon(file.starred ? 'star' : 'starOutline', { size: 22 })}
      </button>
      <button class="dr-icon-btn" data-action="open-preview" title="Quick preview">
        ${icon('visibility', { size: 22 })}
      </button>
      ${file.capabilities.canShare !== false ? `
        <button class="dr-btn dr-btn-primary" data-action="viewer-share">
          ${icon('personAdd', { size: 18 })}<span>Share</span>
        </button>` : ''}
      <a class="dr-icon-btn" href="${esc(contentUrl(file, false))}"
         download="${esc(file.name)}" title="Download">${icon('download', { size: 22 })}</a>
    </header>`;
}

// --- Body -------------------------------------------------------------------

function unsupportedBody(file) {
  const type = fileType(file.mimeType);
  return `
    <div class="dr-viewer-fallback">
      <span style="color:${type.color}">${icon(type.icon, { size: 72 })}</span>
      <h3>No preview available</h3>
      <p>${esc(type.label)} · ${esc(formatFileSize(file.size))}</p>
      <a class="dr-btn dr-btn-primary" href="${esc(contentUrl(file, false))}" download="${esc(file.name)}">
        ${icon('download', { size: 18 })}<span>Download</span>
      </a>
    </div>`;
}

async function renderBody(file, host) {
  const type = fileType(file.mimeType);
  const url = contentUrl(file, true);

  switch (type.kind) {
    case 'image':
      host.innerHTML = `<div class="dr-viewer-media">
        <img class="dr-viewer-image" src="${esc(url)}" alt="${esc(file.name)}">
      </div>`;
      return;

    case 'video':
      host.innerHTML = `<div class="dr-viewer-media">
        <video class="dr-viewer-video" src="${esc(url)}" controls autoplay playsinline></video>
      </div>`;
      return;

    case 'audio':
      host.innerHTML = `<div class="dr-viewer-media dr-viewer-audio-wrap">
        <span class="dr-viewer-audio-glyph">${icon('audiotrack', { size: 72 })}</span>
        <div class="dr-viewer-audio-name">${esc(file.name)}</div>
        <audio class="dr-viewer-audio" src="${esc(url)}" controls autoplay></audio>
      </div>`;
      return;

    case 'pdf':
    case 'gslide':
    case 'gdrawing':
      host.innerHTML = `<iframe class="dr-viewer-frame" src="${esc(url)}" title="${esc(file.name)}"></iframe>`;
      return;

    case 'text':
    case 'code': {
      if (file.size > MAX_TEXT_BYTES) return void (host.innerHTML = unsupportedBody(file));
      host.innerHTML = '<div class="dr-progress" role="progressbar"></div>';
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load file (${response.status})`);
      const text = await response.text();
      host.innerHTML = `<div class="dr-viewer-doc"><pre class="dr-viewer-code">${esc(text)}</pre></div>`;
      return;
    }

    case 'gdoc':
    case 'gsheet': {
      host.innerHTML = '<div class="dr-progress" role="progressbar"></div>';
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not export this file (${response.status})`);
      const html = await response.text();

      // Google's exported HTML is a full document; drop its wrapper and
      // re-host the body in a script-free frame.
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      const styleMatch = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi);
      const inner = (styleMatch ? styleMatch.join('') : '') + (bodyMatch ? bodyMatch[1] : html);

      host.innerHTML = `<iframe class="dr-viewer-frame dr-viewer-frame-doc"
        title="${esc(file.name)}" sandbox="${FRAME_SANDBOX}"></iframe>`;
      const frame = host.querySelector('iframe');
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">`
        + `<base target="_blank">${FRAME_STYLES}</head><body>${inner}</body></html>`;
      return;
    }

    default:
      host.innerHTML = unsupportedBody(file);
  }
}

// --- Entry point ------------------------------------------------------------

/**
 * Paint the file surface. Returns the body element so the caller can mount an
 * editor into it, or null when nothing is open.
 */
export async function renderViewer(container) {
  const file = driveState.openFile;

  if (!file || !driveState.openMode) {
    container.hidden = true;
    container.className = 'dr-viewer';
    container.innerHTML = '';
    return null;
  }

  const isOpen = driveState.openMode === 'open';
  container.hidden = false;
  container.className = `dr-viewer ${isOpen ? 'is-open' : 'is-preview'}`;
  container.innerHTML = (isOpen ? openBar(file) : previewBar(file))
    + '<div class="dr-viewer-body" id="dr-viewer-body"></div>';

  const host = container.querySelector('#dr-viewer-body');
  if (!host) return null;

  if (driveState.openError) {
    host.innerHTML = `<div class="dr-viewer-fallback">
      ${icon('report', { size: 64 })}
      <h3>Could not open this file</h3>
      <p>${esc(driveState.openError)}</p>
    </div>`;
    return host;
  }

  // An editor owns its own body; the caller mounts it.
  if (isOpen && driveState.editor) return host;

  try {
    await renderBody(file, host);
  } catch (err) {
    host.innerHTML = `<div class="dr-viewer-fallback">
      ${icon('report', { size: 64 })}
      <h3>Could not open this file</h3>
      <p>${esc(err.message)}</p>
      <a class="dr-btn" href="${esc(contentUrl(file, false))}" download="${esc(file.name)}">Download instead</a>
    </div>`;
  }
  return host;
}

export { FRAME_SANDBOX, FRAME_STYLES, nativeEditor };

// Folder downloads.
//
// A single file downloads directly. Anything involving a folder — one folder,
// or a mixed multi-selection — is walked on the server and zipped in the
// browser. Where the File System Access API exists the archive streams
// straight to disk; otherwise it is assembled in memory and handed over as a
// Blob, which is what caps the fallback path.

import { driveApi, contentUrl } from './api.js';
import { driveState, setDriveState } from './state.js';
import { toast } from '../actions.js';
import { createZip, ZIP32_LIMIT } from './zip.js';
import { formatFileSize } from './util.js';

// Below this, assembling in memory is unremarkable; above it, warn first.
const MEMORY_WARN_BYTES = 500 * 1024 * 1024;

let controller = null;

function progress(patch) {
  setDriveState({ transfer: { ...(driveState.transfer || {}), ...patch } });
}

function clearProgress() {
  setDriveState({ transfer: null });
}

export function cancelDownload() {
  if (controller) controller.abort();
}

export function isDownloading() {
  return !!driveState.transfer && driveState.transfer.status === 'running';
}

// --- Sinks ------------------------------------------------------------------

/**
 * Stream to disk when the browser allows it, so archive size is bounded by the
 * filesystem rather than by a tab's memory.
 */
async function openSink(filename) {
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }]
      });
      const writable = await handle.createWritable();
      return {
        streaming: true,
        write: chunk => writable.write(chunk),
        async close() { await writable.close(); },
        async abort() { try { await writable.abort(); } catch (e) { /* already gone */ } }
      };
    } catch (err) {
      // A cancelled picker is the user saying no; anything else falls back.
      if (err && err.name === 'AbortError') throw err;
    }
  }

  const parts = [];
  return {
    streaming: false,
    write(chunk) { parts.push(chunk.slice()); },
    async close() {
      const blob = new Blob(parts, { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
    async abort() { parts.length = 0; }
  };
}

// --- Manifest ---------------------------------------------------------------

/**
 * Build one flat list of ZIP entries for a selection.
 *
 * Each root already arrives path-prefixed with its own name, so several
 * selected folders naturally become several top-level directories. Two roots
 * can still share a name, so those are disambiguated here.
 */
async function buildManifest(files, signal) {
  const entries = [];
  const rootNames = new Set();
  let totalBytes = 0;
  let truncated = false;

  for (const file of files) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    progress({ phase: 'scanning', label: file.name });

    const tree = await driveApi.tree(file.id);
    const rootName = tree.root.name;

    // Give a colliding root a suffix and rewrite its subtree's paths to match.
    let prefix = rootName;
    if (rootNames.has(prefix.toLowerCase())) {
      for (let n = 2; rootNames.has(prefix.toLowerCase()); n++) prefix = `${rootName} (${n})`;
    }
    rootNames.add(prefix.toLowerCase());

    for (const entry of tree.entries) {
      const path = prefix === rootName
        ? entry.path
        : prefix + entry.path.slice(rootName.length);
      entries.push({ ...entry, path });
    }

    totalBytes += tree.totalBytes;
    truncated = truncated || tree.truncated;
  }

  return { entries, totalBytes, truncated };
}

// --- Main -------------------------------------------------------------------

/** Download a single file with no archive wrapper. */
function downloadSingleFile(file) {
  const anchor = document.createElement('a');
  anchor.href = contentUrl(file, false);
  anchor.download = file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Download a selection. One plain file goes straight through; a folder or a
 * multi-selection becomes a ZIP.
 *
 * @param {Array} files shaped Drive files
 * @param {string} [archiveName] overrides the .zip filename
 */
export async function downloadFiles(files, archiveName) {
  const items = (files || []).filter(Boolean);
  if (!items.length) return;

  if (isDownloading()) {
    toast('A download is already running.');
    return;
  }

  if (items.length === 1 && !items[0].isFolder) {
    downloadSingleFile(items[0]);
    return;
  }

  controller = new AbortController();
  const { signal } = controller;

  const zipName = archiveName
    || (items.length === 1 ? `${items[0].name}.zip` : `Maton Drive (${items.length} items).zip`);

  progress({ status: 'running', phase: 'scanning', label: '', done: 0, total: 0, bytes: 0, name: zipName });

  let sink = null;
  try {
    const manifest = await buildManifest(items, signal);
    const downloadable = manifest.entries.filter(entry => !entry.isFolder);

    if (!downloadable.length && !manifest.entries.length) {
      clearProgress();
      toast('Nothing to download — that folder is empty.');
      return;
    }

    if (manifest.truncated) {
      const proceed = confirm(
        `This selection has more than ${manifest.entries.length} items and was truncated. `
        + 'Download the first part anyway?'
      );
      if (!proceed) { clearProgress(); return; }
    }

    // Native exports report no size, so the total is a floor, not a ceiling.
    if (manifest.totalBytes > ZIP32_LIMIT) {
      clearProgress();
      toast(`That selection is ${formatFileSize(manifest.totalBytes)}, over the 4 GB ZIP limit. `
        + 'Download it in smaller parts.');
      return;
    }

    progress({ phase: 'zipping', total: downloadable.length, done: 0 });

    sink = await openSink(zipName);

    if (!sink.streaming && manifest.totalBytes > MEMORY_WARN_BYTES) {
      const proceed = confirm(
        `This browser cannot stream the archive to disk, so ${formatFileSize(manifest.totalBytes)} `
        + 'will be held in memory. Continue?'
      );
      if (!proceed) { await sink.abort(); clearProgress(); return; }
    }

    const zip = createZip(chunk => sink.write(chunk));
    const failures = [];

    // Directories first, so empty ones are preserved.
    for (const entry of manifest.entries.filter(e => e.isFolder)) {
      await zip.addDirectory(entry.path);
    }

    let completed = 0;
    for (const entry of downloadable) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

      progress({ phase: 'zipping', label: entry.path, done: completed, bytes: zip.bytesWritten });

      try {
        const response = await fetch(
          contentUrl({ id: entry.id, name: entry.path, mimeType: entry.mimeType }, false),
          { signal }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        await zip.addFile(entry.path, response.body || new Uint8Array(await response.arrayBuffer()));
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        // One unreadable file should not cost the whole archive.
        failures.push(entry.path);
      }

      completed++;
      progress({ done: completed, bytes: zip.bytesWritten });
    }

    await zip.finish();
    await sink.close();
    clearProgress();

    if (failures.length) {
      toast(`Downloaded with ${failures.length} file${failures.length > 1 ? 's' : ''} skipped: `
        + failures.slice(0, 3).join(', ') + (failures.length > 3 ? '…' : ''));
    } else {
      toast(`Downloaded ${zipName}`);
    }
  } catch (err) {
    if (sink) await sink.abort();
    clearProgress();
    if (err && err.name === 'AbortError') toast('Download cancelled.');
    else toast(`Download failed: ${err.message}`);
  } finally {
    controller = null;
  }
}

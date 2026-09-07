// Drive-specific helpers: file typing, iconography, formatting.

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Map a MIME type to the icon name and brand colour Drive uses for it.
 * `kind` drives which viewer opens the file.
 */
const TYPE_TABLE = [
  { test: m => m === FOLDER_MIME, kind: 'folder', icon: 'folder', color: '#5f6368', label: 'Folder' },
  { test: m => m === 'application/vnd.google-apps.document', kind: 'gdoc', icon: 'description', color: '#4285f4', label: 'Google Docs' },
  { test: m => m === 'application/vnd.google-apps.spreadsheet', kind: 'gsheet', icon: 'table', color: '#0f9d58', label: 'Google Sheets' },
  { test: m => m === 'application/vnd.google-apps.presentation', kind: 'gslide', icon: 'slideshow', color: '#f4b400', label: 'Google Slides' },
  { test: m => m === 'application/vnd.google-apps.drawing', kind: 'gdrawing', icon: 'image', color: '#db4437', label: 'Google Drawing' },
  { test: m => m === 'application/vnd.google-apps.form', kind: 'gform', icon: 'description', color: '#7627bb', label: 'Google Forms' },
  { test: m => m === 'application/pdf', kind: 'pdf', icon: 'pictureAsPdf', color: '#db4437', label: 'PDF' },
  { test: m => m.startsWith('image/'), kind: 'image', icon: 'image', color: '#db4437', label: 'Image' },
  { test: m => m.startsWith('video/'), kind: 'video', icon: 'movie', color: '#db4437', label: 'Video' },
  { test: m => m.startsWith('audio/'), kind: 'audio', icon: 'audiotrack', color: '#db4437', label: 'Audio' },
  { test: m => /zip|compressed|tar|rar|7z/.test(m), kind: 'archive', icon: 'folderZip', color: '#5f6368', label: 'Archive' },
  { test: m => /json|javascript|xml|html|css|typescript|x-sh|x-python/.test(m), kind: 'code', icon: 'code', color: '#5f6368', label: 'Code' },
  { test: m => m.startsWith('text/'), kind: 'text', icon: 'description', color: '#4285f4', label: 'Text' },
  { test: m => /wordprocessingml|msword/.test(m), kind: 'office-doc', icon: 'description', color: '#4285f4', label: 'Word' },
  { test: m => /spreadsheetml|ms-excel/.test(m), kind: 'office-sheet', icon: 'table', color: '#0f9d58', label: 'Excel' },
  { test: m => /presentationml|ms-powerpoint/.test(m), kind: 'office-slide', icon: 'slideshow', color: '#f4b400', label: 'PowerPoint' }
];

const FALLBACK = { kind: 'binary', icon: 'insertDriveFile', color: '#5f6368', label: 'File' };

export function fileType(mimeType = '') {
  const mime = String(mimeType || '');
  return TYPE_TABLE.find(entry => entry.test(mime)) || FALLBACK;
}

/** Which of the three native editors, if any, can open this file. */
export function nativeEditor(file) {
  if (!file) return null;
  if (file.mimeType === 'application/vnd.google-apps.spreadsheet') return 'sheets';
  if (file.mimeType === 'application/vnd.google-apps.document') return 'docs';
  return null;
}

/** True when the in-app viewer can render this file without exporting it. */
export function isDirectlyViewable(file) {
  const { kind } = fileType(file.mimeType);
  return ['pdf', 'image', 'video', 'audio', 'text', 'code'].includes(kind);
}

export function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (!size) return '—';
  if (size < 1024) return `${size} bytes`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Drive's modified column: time today, "MMM d" this year, else "MMM d, yyyy". */
export function formatDriveDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatFullDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

/** Percentage of the storage quota consumed, clamped for the meter. */
export function quotaPercent(quota) {
  if (!quota || !quota.limit) return 0;
  const used = Number(quota.usage || 0);
  const limit = Number(quota.limit || 0);
  if (!limit) return 0;
  return Math.min(100, (used / limit) * 100);
}

/**
 * Convert an A1 column index to its letter form (0 -> A, 26 -> AA).
 * Used by the Sheets grid to build ranges.
 */
export function columnLetter(index) {
  let n = index;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

export function a1Range(sheetTitle, startRow, startCol, endRow, endCol) {
  const prefix = sheetTitle ? `'${String(sheetTitle).replace(/'/g, "''")}'!` : '';
  return `${prefix}${columnLetter(startCol)}${startRow + 1}:${columnLetter(endCol)}${endRow + 1}`;
}

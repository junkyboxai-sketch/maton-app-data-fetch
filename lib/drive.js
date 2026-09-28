// Drive domain helpers: field sets, query building, export formats, shaping.

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

// Everything the list, details panel and viewer need in one round trip.
const FILE_FIELDS = [
  'id', 'name', 'mimeType', 'size', 'quotaBytesUsed',
  'createdTime', 'modifiedTime', 'viewedByMeTime', 'sharedWithMeTime',
  'starred', 'trashed', 'explicitlyTrashed', 'shared', 'ownedByMe',
  'parents', 'webViewLink', 'iconLink', 'thumbnailLink', 'fileExtension',
  'owners(displayName,emailAddress,photoLink)',
  'lastModifyingUser(displayName,emailAddress,photoLink)',
  'capabilities(canEdit,canDelete,canRename,canShare,canTrash,canUntrash,canCopy,canDownload)',
  'shortcutDetails(targetId,targetMimeType)'
].join(',');

const LIST_FIELDS = `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`;

// Google-native types cannot be downloaded directly; they must be exported.
// `preview` is what the in-app viewer renders, `download` is what a
// Download click produces.
const EXPORT_FORMATS = {
  'application/vnd.google-apps.document': {
    preview: 'text/html',
    download: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx'
  },
  'application/vnd.google-apps.spreadsheet': {
    preview: 'text/html',
    download: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx'
  },
  'application/vnd.google-apps.presentation': {
    preview: 'application/pdf',
    download: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx'
  },
  'application/vnd.google-apps.drawing': {
    preview: 'image/png',
    download: 'image/png',
    extension: '.png'
  },
  'application/vnd.google-apps.script': {
    preview: 'application/json',
    download: 'application/vnd.google-apps.script+json',
    extension: '.json'
  }
};

function isGoogleNative(mimeType) {
  return typeof mimeType === 'string'
    && mimeType.startsWith('application/vnd.google-apps.')
    && mimeType !== FOLDER_MIME
    && mimeType !== SHORTCUT_MIME;
}

function exportFormat(mimeType, kind = 'preview') {
  const entry = EXPORT_FORMATS[mimeType];
  if (!entry) return { mimeType: 'application/pdf', extension: '.pdf' };
  return { mimeType: entry[kind], extension: entry.extension };
}

// Drive query strings are single-quoted; a quote in user input would
// otherwise let the search term change the query's meaning.
function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Build a Drive `q` for one of the app's views.
 * @param {object} options
 * @param {string} options.view   mydrive|shared|recent|starred|trash|folder
 * @param {string} [options.parent] folder id, when view is 'folder'
 * @param {string} [options.search] free-text search, overrides the view scope
 */
function buildQuery({ view, parent, search }) {
  const parts = [];

  if (search) {
    parts.push(`name contains '${escapeQueryValue(search)}'`);
    parts.push('trashed = false');
    return parts.join(' and ');
  }

  switch (view) {
    case 'folder':
      parts.push(`'${escapeQueryValue(parent || 'root')}' in parents`);
      parts.push('trashed = false');
      break;
    case 'shared':
      parts.push('sharedWithMe = true');
      parts.push('trashed = false');
      break;
    case 'starred':
      parts.push('starred = true');
      parts.push('trashed = false');
      break;
    case 'recent':
      parts.push('trashed = false');
      parts.push(`mimeType != '${FOLDER_MIME}'`);
      break;
    case 'trash':
      parts.push('trashed = true');
      break;
    case 'mydrive':
    default:
      parts.push("'root' in parents");
      parts.push('trashed = false');
      break;
  }
  return parts.join(' and ');
}

// Drive rejects unknown orderBy keys, so only allow the ones the UI offers.
const SORT_KEYS = {
  name: 'name',
  modified: 'modifiedTime desc',
  modifiedAsc: 'modifiedTime',
  size: 'quotaBytesUsed desc',
  created: 'createdTime desc',
  opened: 'viewedByMeTime desc'
};

function buildOrderBy(sort, view) {
  if (view === 'recent') return SORT_KEYS.opened;
  const key = SORT_KEYS[sort] || SORT_KEYS.name;
  // Folders first, mirroring Drive, except when sorting by recency.
  return key.startsWith('name') ? `folder,${key}` : key;
}

/** Trim a Drive file to the shape the client renders. */
function shapeFile(file) {
  if (!file) return null;
  const owner = (file.owners && file.owners[0]) || null;
  const modifier = file.lastModifyingUser || null;

  return {
    id: file.id,
    name: file.name || 'Untitled',
    mimeType: file.mimeType,
    isFolder: file.mimeType === FOLDER_MIME,
    isShortcut: file.mimeType === SHORTCUT_MIME,
    isGoogleNative: isGoogleNative(file.mimeType),
    shortcutTarget: file.shortcutDetails
      ? { id: file.shortcutDetails.targetId, mimeType: file.shortcutDetails.targetMimeType }
      : null,
    size: Number(file.size || file.quotaBytesUsed || 0),
    extension: file.fileExtension || '',
    createdTime: file.createdTime || null,
    modifiedTime: file.modifiedTime || null,
    viewedByMeTime: file.viewedByMeTime || null,
    sharedWithMeTime: file.sharedWithMeTime || null,
    starred: !!file.starred,
    trashed: !!file.trashed,
    shared: !!file.shared,
    ownedByMe: file.ownedByMe !== false,
    parents: file.parents || [],
    webViewLink: file.webViewLink || null,
    thumbnailLink: file.thumbnailLink || null,
    owner: owner ? { name: owner.displayName, email: owner.emailAddress, photo: owner.photoLink } : null,
    modifiedBy: modifier ? { name: modifier.displayName, email: modifier.emailAddress } : null,
    capabilities: file.capabilities || {}
  };
}

function shapePermission(permission) {
  return {
    id: permission.id,
    type: permission.type,
    role: permission.role,
    name: permission.displayName || permission.emailAddress || 'Anyone with the link',
    email: permission.emailAddress || '',
    photo: permission.photoLink || null,
    domain: permission.domain || '',
    deleted: !!permission.deleted,
    pendingOwner: !!permission.pendingOwner
  };
}

// --- Folder download ---------------------------------------------------------
//
// Drive has no "download this folder" endpoint; the web UI zips server side.
// These helpers support walking a folder into a flat manifest that a client
// can turn into a ZIP. The caps keep a pathological tree from stalling the
// serverless function.

const MAX_TREE_ENTRIES = 2000;
const MAX_TREE_DEPTH = 20;

// Characters that are illegal in a Windows path or would change a ZIP's shape.
const ILLEGAL_SEGMENT = /[/\\:*?"<>|\x00-\x1f]/g;

/**
 * Make one path segment safe for a ZIP entry and for every major filesystem.
 * Windows also rejects a trailing dot or space, and reserves a few device names.
 */
function sanitizeSegment(name) {
  let safe = String(name == null ? '' : name).replace(ILLEGAL_SEGMENT, '_');
  safe = safe.replace(/[. ]+$/, '');
  if (!safe) safe = 'untitled';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)) safe = `_${safe}`;
  return safe.slice(0, 180);
}

/** The extension a Google-native file gains once exported for download. */
function downloadExtension(mimeType) {
  if (!isGoogleNative(mimeType)) return '';
  return exportFormat(mimeType, 'download').extension || '';
}

/**
 * The name a file takes inside the archive: sanitized, with the export
 * extension appended for native Google types that have none.
 */
function archiveName(name, mimeType) {
  const safe = sanitizeSegment(name);
  const extension = downloadExtension(mimeType);
  if (!extension || safe.toLowerCase().endsWith(extension.toLowerCase())) return safe;
  return safe + extension;
}

/**
 * Keep sibling names unique. Two Drive files may share a name, and two
 * different names can collide once sanitized; a ZIP with duplicates unpacks
 * unpredictably, so disambiguate the later ones the way a browser does.
 */
function uniqueName(name, taken) {
  const key = name.toLowerCase();
  if (!taken.has(key)) {
    taken.add(key);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';

  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  const fallback = `${stem} (${Date.now()})${extension}`;
  taken.add(fallback.toLowerCase());
  return fallback;
}

module.exports = {
  FOLDER_MIME,
  SHORTCUT_MIME,
  FILE_FIELDS,
  LIST_FIELDS,
  EXPORT_FORMATS,
  MAX_TREE_ENTRIES,
  MAX_TREE_DEPTH,
  isGoogleNative,
  exportFormat,
  escapeQueryValue,
  buildQuery,
  buildOrderBy,
  shapeFile,
  shapePermission,
  sanitizeSegment,
  downloadExtension,
  archiveName,
  uniqueName
};

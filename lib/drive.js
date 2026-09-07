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

module.exports = {
  FOLDER_MIME,
  SHORTCUT_MIME,
  FILE_FIELDS,
  LIST_FIELDS,
  EXPORT_FORMATS,
  isGoogleNative,
  exportFormat,
  escapeQueryValue,
  buildQuery,
  buildOrderBy,
  shapeFile,
  shapePermission
};

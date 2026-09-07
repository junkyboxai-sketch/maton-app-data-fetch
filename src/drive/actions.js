// Drive mutations. Each applies optimistically, calls the API, rolls back on error.

import { driveApi } from './api.js';
import { driveState, setDriveState, patchFiles, removeFiles, clearSelection, emitDrive } from './state.js';
import { toast } from '../actions.js';

/** Ask the list to reload itself after a change that alters membership. */
function notifyChanged() {
  document.dispatchEvent(new CustomEvent('drive:changed'));
}

async function run(optimistic, call, { message, undo, reload } = {}) {
  const snapshot = driveState.files.slice();
  optimistic();

  try {
    await call();
    if (message) toast(message, undo || null);
    if (reload) notifyChanged();
  } catch (err) {
    setDriveState({ files: snapshot });
    emitDrive(['files']);
    toast(err.message || 'Action failed');
  }
}

export function setStarred(ids, starred) {
  return run(
    () => patchFiles(ids, { starred }),
    () => driveApi.batch(ids, starred ? 'star' : 'unstar'),
    {
      message: starred
        ? `Added ${ids.length > 1 ? ids.length + ' items' : 'item'} to Starred`
        : 'Removed from Starred',
      reload: driveState.view === 'starred'
    }
  );
}

export function trash(ids, names = []) {
  const label = ids.length > 1 ? `${ids.length} items` : (names[0] || 'Item');
  return run(
    () => removeFiles(ids),
    () => driveApi.batch(ids, 'trash'),
    {
      message: `${label} moved to trash`,
      undo: () => restore(ids),
      reload: true
    }
  );
}

export function restore(ids) {
  return run(
    () => removeFiles(ids),
    () => driveApi.batch(ids, 'restore'),
    { message: 'Restored from trash', reload: true }
  );
}

export function deleteForever(ids) {
  const label = ids.length > 1 ? `${ids.length} items` : 'this item';
  if (!confirm(`Delete ${label} forever? This cannot be undone.`)) return Promise.resolve();
  return run(
    () => removeFiles(ids),
    () => driveApi.batch(ids, 'delete'),
    { message: 'Deleted forever', reload: true }
  );
}

export async function rename(file) {
  const name = prompt('Rename', file.name);
  if (!name || name === file.name) return;

  await run(
    () => patchFiles([file.id], { name }),
    () => driveApi.update(file.id, { name }),
    { message: 'Renamed' }
  );

  if (driveState.detailsFor && driveState.detailsFor.id === file.id) {
    setDriveState({ detailsFor: { ...driveState.detailsFor, name } });
  }
  if (driveState.openFile && driveState.openFile.id === file.id) {
    setDriveState({ openFile: { ...driveState.openFile, name } });
  }
}

export async function copy(file) {
  const name = prompt('Name for the copy', `Copy of ${file.name}`);
  if (!name) return;

  try {
    await driveApi.copy(file.id, name, (file.parents || [])[0]);
    toast('Copy created');
    notifyChanged();
  } catch (err) {
    toast(err.message);
  }
}

export async function createFolder(parentId) {
  const name = prompt('New folder name', 'Untitled folder');
  if (!name || !name.trim()) return;

  try {
    await driveApi.createFolder(name.trim(), parentId || 'root');
    toast('Folder created');
    notifyChanged();
  } catch (err) {
    toast(err.message);
  }
}

/** Move items into a folder — used by drag-and-drop and the move dialog. */
export async function move(ids, targetFolderId, currentParentId) {
  if (!ids.length || !targetFolderId) return;
  if (ids.includes(targetFolderId)) {
    toast('A folder cannot be moved into itself');
    return;
  }

  await run(
    () => removeFiles(ids),
    () => driveApi.batch(ids, 'move', {
      addParents: targetFolderId,
      removeParents: currentParentId || ''
    }),
    {
      message: `Moved ${ids.length > 1 ? ids.length + ' items' : 'item'}`,
      reload: true
    }
  );
  clearSelection();
}

export { toast };

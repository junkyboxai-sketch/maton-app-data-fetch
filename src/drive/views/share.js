// Drive's share dialog: who has access, add people by email, change roles.

import { icon } from '../../icons.js';
import { esc, initials } from '../../util.js';
import { driveApi } from '../api.js';
import { driveState, setDriveState } from '../state.js';
import { toast } from '../../actions.js';

const ROLES = [
  { id: 'reader', label: 'Viewer' },
  { id: 'commenter', label: 'Commenter' },
  { id: 'writer', label: 'Editor' }
];

const ROLE_LABEL = { reader: 'Viewer', commenter: 'Commenter', writer: 'Editor', owner: 'Owner' };

function roleSelect(permission) {
  const isOwner = permission.role === 'owner';
  if (isOwner) return '<span class="dr-role-static">Owner</span>';

  return `<select class="dr-role-select" data-permission-id="${esc(permission.id)}"
                  aria-label="Role for ${esc(permission.name)}">
    ${ROLES.map(role => `
      <option value="${role.id}"${permission.role === role.id ? ' selected' : ''}>${esc(role.label)}</option>
    `).join('')}
    <option value="remove">Remove access</option>
  </select>`;
}

function personRow(permission) {
  const isLink = permission.type === 'anyone';
  const name = isLink ? 'Anyone with the link' : permission.name;
  const sub = isLink
    ? `Anyone on the internet with the link can ${permission.role === 'writer' ? 'edit' : 'view'}`
    : (permission.email || permission.domain || '');

  return `
    <li class="dr-share-person">
      <span class="dr-person-avatar${isLink ? ' is-link' : ''}">
        ${isLink ? icon('link', { size: 18 }) : esc(initials(name))}
      </span>
      <span class="dr-share-person-text">
        <span class="dr-share-person-name">${esc(name)}</span>
        ${sub ? `<span class="dr-share-person-sub">${esc(sub)}</span>` : ''}
      </span>
      ${roleSelect(permission)}
    </li>`;
}

export function renderShare(container) {
  const file = driveState.shareFile;
  if (!file) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;

  const linkPermission = driveState.sharePermissions.find(p => p.type === 'anyone');

  container.innerHTML = `
    <div class="dr-modal" role="dialog" aria-modal="true" aria-label="Share ${esc(file.name)}">
      <div class="dr-modal-head">
        <h3>Share “${esc(file.name)}”</h3>
        <button class="dr-icon-btn" data-action="close-share" title="Close">${icon('close', { size: 20 })}</button>
      </div>

      <div class="dr-modal-body">
        <form class="dr-share-add" data-action="add-person">
          <input type="email" class="dr-share-input" name="email" placeholder="Add people by email"
                 autocomplete="off" spellcheck="false" required>
          <select class="dr-role-select" name="role">
            ${ROLES.map(r => `<option value="${r.id}"${r.id === 'reader' ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
          </select>
          <button type="submit" class="dr-btn dr-btn-primary">Share</button>
        </form>
        <label class="dr-share-notify">
          <input type="checkbox" name="notify" checked> Notify people by email
        </label>

        <h4 class="dr-share-section">People with access</h4>
        ${driveState.shareLoading
          ? '<div class="dr-progress" role="progressbar"></div>'
          : `<ul class="dr-share-list">
              ${driveState.sharePermissions.filter(p => p.type !== 'anyone').map(personRow).join('')
                || '<li class="dr-share-empty">Only you have access.</li>'}
            </ul>`}

        <h4 class="dr-share-section">General access</h4>
        <ul class="dr-share-list">
          ${linkPermission
            ? personRow(linkPermission)
            : `<li class="dr-share-person">
                 <span class="dr-person-avatar is-link">${icon('link', { size: 18 })}</span>
                 <span class="dr-share-person-text">
                   <span class="dr-share-person-name">Restricted</span>
                   <span class="dr-share-person-sub">Only people with access can open</span>
                 </span>
                 <button class="dr-btn" data-action="enable-link">Get link</button>
               </li>`}
        </ul>
      </div>

      <div class="dr-modal-foot">
        ${file.webViewLink ? `
          <button class="dr-btn" data-action="copy-link">
            ${icon('link', { size: 18 })}<span>Copy link</span>
          </button>` : '<span></span>'}
        <button class="dr-btn dr-btn-primary" data-action="close-share">Done</button>
      </div>
    </div>`;
}

export async function loadPermissions(file) {
  setDriveState({ shareFile: file, sharePermissions: [], shareLoading: true });
  try {
    const data = await driveApi.permissions(file.id);
    setDriveState({ sharePermissions: data.permissions || [], shareLoading: false });
  } catch (err) {
    setDriveState({ shareLoading: false });
    toast(err.message);
  }
}

export async function addPerson(file, email, role, notify) {
  try {
    await driveApi.addPermission(file.id, { type: 'user', emailAddress: email, role, notify });
    toast(`Shared with ${email}`);
    await loadPermissions(file);
  } catch (err) {
    toast(err.message);
  }
}

export async function changeRole(file, permissionId, role) {
  try {
    if (role === 'remove') {
      await driveApi.removePermission(file.id, permissionId);
      toast('Access removed');
    } else {
      await driveApi.updatePermission(file.id, permissionId, role);
      toast('Role updated');
    }
    await loadPermissions(file);
  } catch (err) {
    toast(err.message);
  }
}

export async function enableLinkSharing(file) {
  try {
    await driveApi.addPermission(file.id, { type: 'anyone', role: 'reader', notify: false });
    toast('Link sharing on — anyone with the link can view');
    await loadPermissions(file);
  } catch (err) {
    toast(err.message);
  }
}

export { ROLE_LABEL };

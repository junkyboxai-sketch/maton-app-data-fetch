// The Maton API key dialog: add a key, switch between saved keys, reveal one.

import { icon } from './icons.js';
import { esc } from './util.js';
import {
  listKeys, getKey, saveKey, selectKey, removeKey, activeKey, maskKey
} from './keystore.js';

let host = null;
let open = false;
let revealed = new Set();   // ids whose full key is currently shown
let showNewKey = false;     // eye state for the "add a key" field
let busy = false;
let status = null;          // { tone: 'ok' | 'error', text }

function formatWhen(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function keyRow(entry) {
  const isRevealed = revealed.has(entry.id);
  return `
    <li class="ms-key${entry.isActive ? ' is-active' : ''}" data-key-id="${esc(entry.id)}">
      <div class="ms-key-main">
        <div class="ms-key-label">
          <span class="ms-key-name">${esc(entry.label)}</span>
          ${entry.isActive ? '<span class="ms-badge">In use</span>' : ''}
        </div>
        <code class="ms-key-value${isRevealed ? ' is-revealed' : ''}">${
          esc(isRevealed ? entry.key : maskKey(entry.key))
        }</code>
        <div class="ms-key-meta">Added ${esc(formatWhen(entry.addedAt))}</div>
      </div>
      <div class="ms-key-actions">
        <button class="ms-icon-btn" data-act="reveal" data-id="${esc(entry.id)}"
                title="${isRevealed ? 'Hide key' : 'Show key'}"
                aria-pressed="${isRevealed}">
          ${icon(isRevealed ? 'visibilityOff' : 'visibility', { size: 18 })}
        </button>
        <button class="ms-icon-btn" data-act="copy" data-id="${esc(entry.id)}" title="Copy key">
          ${icon('contentCopy', { size: 18 })}
        </button>
        ${entry.isActive ? '' : `
          <button class="ms-btn ms-btn-small" data-act="use" data-id="${esc(entry.id)}">Use</button>`}
        <button class="ms-icon-btn ms-danger" data-act="forget" data-id="${esc(entry.id)}" title="Forget key">
          ${icon('delete', { size: 18 })}
        </button>
      </div>
    </li>`;
}

function render() {
  if (!host) return;

  if (!open) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }

  const keys = listKeys();
  const current = activeKey();

  host.hidden = false;
  host.innerHTML = `
    <div class="ms-modal" role="dialog" aria-modal="true" aria-label="Maton API key settings">
      <div class="ms-modal-head">
        <h3>Maton API keys</h3>
        <button class="ms-icon-btn" data-act="close" title="Close">${icon('close', { size: 20 })}</button>
      </div>

      <div class="ms-modal-body">
        <p class="ms-desc">
          Keys are stored in this browser only and stay configured until you switch or remove them.
        </p>

        <div class="ms-status ms-status-${current ? 'ok' : 'warn'}">
          ${icon(current ? 'markRead' : 'report', { size: 18 })}
          <span>${current
            ? `Connected using <strong>${esc((keys.find(k => k.isActive) || {}).label || 'a saved key')}</strong>`
            : 'No key configured — add one below to load your data.'}</span>
        </div>

        <h4 class="ms-section">Add a key</h4>
        <form class="ms-add" data-act="add">
          <div class="ms-field">
            <input type="${showNewKey ? 'text' : 'password'}" name="key" class="ms-input"
                   placeholder="Paste your Maton API key" autocomplete="off" spellcheck="false"
                   ${busy ? 'disabled' : ''}>
            <button type="button" class="ms-icon-btn ms-field-btn" data-act="toggle-new"
                    title="${showNewKey ? 'Hide key' : 'Show key'}" aria-pressed="${showNewKey}">
              ${icon(showNewKey ? 'visibilityOff' : 'visibility', { size: 18 })}
            </button>
          </div>
          <input type="text" name="label" class="ms-input ms-input-label"
                 placeholder="Name (optional)" autocomplete="off" ${busy ? 'disabled' : ''}>
          <button type="submit" class="ms-btn ms-btn-primary" ${busy ? 'disabled' : ''}>
            ${busy ? 'Checking…' : 'Save &amp; use'}
          </button>
        </form>
        ${status ? `<div class="ms-inline ms-inline-${status.tone}">${esc(status.text)}</div>` : ''}

        <h4 class="ms-section">Saved keys${keys.length ? ` <span class="ms-count">${keys.length}</span>` : ''}</h4>
        ${keys.length
          ? `<ul class="ms-key-list">${keys.map(keyRow).join('')}</ul>`
          : '<p class="ms-empty">No keys saved yet.</p>'}
      </div>

      <div class="ms-modal-foot">
        <span class="ms-foot-note">Stored locally in this browser.</span>
        <button class="ms-btn" data-act="close">Done</button>
      </div>
    </div>`;
}

/** Validate a key against Maton before it replaces a working one. */
async function verify(key) {
  const response = await fetch('/api/gmail/profile', {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (response.ok) return true;

  const body = await response.json().catch(() => ({}));
  throw new Error(body.error || `Maton rejected this key (${response.status})`);
}

async function handleAdd(form) {
  const key = form.key.value.trim();
  const label = form.label.value.trim();
  if (!key) return;

  busy = true;
  status = null;
  render();

  try {
    await verify(key);
    saveKey(key, label);
    status = { tone: 'ok', text: 'Key saved and now in use.' };
  } catch (err) {
    status = { tone: 'error', text: err.message };
  } finally {
    busy = false;
    render();
  }
}

function bind() {
  host.addEventListener('click', async event => {
    if (event.target === host) return close();

    const trigger = event.target.closest('[data-act]');
    if (!trigger) return;
    const id = trigger.dataset.id;

    switch (trigger.dataset.act) {
      case 'close':
        close();
        break;
      case 'toggle-new':
        showNewKey = !showNewKey;
        render();
        break;
      case 'reveal':
        if (revealed.has(id)) revealed.delete(id);
        else revealed.add(id);
        render();
        break;
      case 'copy': {
        const entry = getKey(id);
        if (!entry) break;
        try {
          await navigator.clipboard.writeText(entry.key);
          status = { tone: 'ok', text: `Copied “${entry.label}” to the clipboard.` };
        } catch (e) {
          status = { tone: 'error', text: 'Could not copy — reveal the key and copy it manually.' };
        }
        render();
        break;
      }
      case 'use': {
        const entry = selectKey(id);
        status = entry
          ? { tone: 'ok', text: `Now using “${entry.label}”.` }
          : { tone: 'error', text: 'That key is no longer saved.' };
        render();
        break;
      }
      case 'forget': {
        const entry = getKey(id);
        if (!entry) break;
        if (!confirm(`Forget “${entry.label}”? You will need the key itself to add it again.`)) break;
        removeKey(id);
        revealed.delete(id);
        status = { tone: 'ok', text: `Removed “${entry.label}”.` };
        render();
        break;
      }
      default:
        break;
    }
  });

  host.addEventListener('submit', event => {
    if (!event.target.matches('[data-act="add"]')) return;
    event.preventDefault();
    handleAdd(event.target);
  });

  document.addEventListener('keydown', event => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
}

export function openSettings() {
  open = true;
  status = null;
  revealed.clear();
  showNewKey = false;
  render();
}

export function close() {
  open = false;
  render();
}

export function initSettings(element, triggerButton) {
  host = element;
  bind();
  if (triggerButton) triggerButton.addEventListener('click', openSettings);

  // Any workspace can prompt for a key when a request comes back unauthorized.
  document.addEventListener('maton:need-key', openSettings);
  render();
}

export { listKeys, activeKey };

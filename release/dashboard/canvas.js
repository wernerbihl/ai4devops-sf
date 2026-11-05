import { mountFactoryUI, createFactoryClient, ApiFailure } from './factory-ui.js';
import { createWebSocketTransport } from './channel.js';
const target = document.getElementById('app');
const themes = new Set(['system', 'light', 'dark']);
const listeners = new Set();
let active = true;
let transport;
let unmount;
let appearance;
let select;
function changeAppearance() {
  if (!active || !themes.has(select.value)) return;
  for (const listener of listeners) listener(select.value);
}
function dispose() {
  if (!active) return;
  active = false;
  removeEventListener('pagehide', dispose);
  select?.removeEventListener('change', changeAppearance);
  appearance?.remove();
  listeners.clear();
  unmount?.();
  transport?.dispose();
}
try {
  transport = createWebSocketTransport({ failure: (status, detail) => new ApiFailure(status, detail) });
  // Current Canvas SDK exposes no host-selected theme. This is an explicit,
  // ephemeral Appearance choice; System follows document media, not a host API.
  unmount = mountFactoryUI(target, {
    client: createFactoryClient(transport), theme: 'system',
    subscribeTheme(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
  const root = target.querySelector('[data-factory-root]');
  if (!root) throw Error('Factory application mount missing');
  appearance = document.createElement('label');
  appearance.className = 'factory-canvas-appearance';
  const caption = document.createElement('span'); caption.textContent = 'Appearance';
  select = document.createElement('select'); select.setAttribute('aria-label', 'Appearance');
  for (const [value, text] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
  }
  appearance.append(caption, select); root.prepend(appearance);
  select.addEventListener('change', changeAppearance);
  addEventListener('pagehide', dispose, { once: true });
} catch {
  dispose();
  target.textContent = 'Reopen Software Factory through the native Canvas host for a fresh trusted connection.';
}

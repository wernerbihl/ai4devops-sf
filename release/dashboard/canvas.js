import { mountFactoryUI, createFactoryClient, ApiFailure } from './factory-ui.js';
import { createWebSocketTransport } from './channel.js';
const target = document.getElementById('app');
let dispose = () => {};
try {
  const transport = createWebSocketTransport({ failure: (status, detail) => new ApiFailure(status, detail) });
  const unmount = mountFactoryUI(target, { client: createFactoryClient(transport), theme: 'system' });
  dispose = () => { unmount(); transport.dispose(); };
} catch { target.textContent = 'Reopen Software Factory through the native Canvas host for a fresh trusted connection.'; }
addEventListener('pagehide', () => dispose(), { once: true });

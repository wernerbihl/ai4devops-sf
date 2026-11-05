import { mountFactoryUI, createFactoryClient, createBrowserTransport } from './factory-ui.js';
const dispose = mountFactoryUI(document.getElementById('app'), { client: createFactoryClient(createBrowserTransport()), theme: 'system' });
addEventListener('pagehide', dispose, { once: true });

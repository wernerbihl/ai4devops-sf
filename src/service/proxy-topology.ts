import { isIPv4 } from 'node:net';
import { ensure } from '../storage/database.ts';

interface Network { Id: string; Internal: boolean; Containers: Record<string, { IPv4Address: string }> | null }
interface Container { Id: string; NetworkSettings: { Networks: Record<string, { NetworkID: string; IPAddress: string }> } }

/** Match both Docker's network membership and each inspected container endpoint. */
export function proxyTopology(internal: Network, egress: Network, native: Container, proxy: Container): { nativeAddress: string; listenAddress: string } {
  ensure(internal && egress && native && proxy && internal.Internal && !egress.Internal && internal.Id !== egress.Id && native.Id !== proxy.Id, 'native_proxy', 'Invalid proxy network identity');
  const members = (network: Network, expected: string[]) => {
    const actual = Object.keys(network.Containers ?? {}).sort();
    ensure(JSON.stringify(actual) === JSON.stringify([...expected].sort()), 'native_proxy', 'Unexpected network peer');
  };
  members(internal, [native.Id, proxy.Id]); members(egress, [proxy.Id]);
  const endpoint = (container: Container, network: Network): string => {
    const entries = Object.values(container.NetworkSettings.Networks).filter(n => n.NetworkID === network.Id);
    const netAddress = network.Containers?.[container.Id]?.IPv4Address;
    ensure(entries.length === 1 && typeof netAddress === 'string' && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(netAddress), 'native_proxy', 'Missing inspected network endpoint');
    const address = netAddress.split('/')[0]!;
    ensure(isIPv4(address) && entries[0]!.IPAddress === address, 'native_proxy', 'Network endpoint address drift');
    return address;
  };
  ensure(Object.keys(native.NetworkSettings.Networks).length === 1 && Object.keys(proxy.NetworkSettings.Networks).length === 2, 'native_proxy', 'Unexpected runtime network');
  const nativeAddress = endpoint(native, internal); const listenAddress = endpoint(proxy, internal); endpoint(proxy, egress);
  ensure(nativeAddress !== listenAddress, 'native_proxy', 'Proxy and native endpoints must differ');
  return { nativeAddress, listenAddress };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyTopology } from '../../src/service/proxy-topology.ts';

test('proxy topology requires exact inspected endpoints and refuses added peers or address drift', () => {
  const internal = {Id:'internal', Internal:true, Containers:{native:{IPv4Address:'172.18.0.2/16'},proxy:{IPv4Address:'172.18.0.3/16'}}};
  const egress = {Id:'egress', Internal:false, Containers:{proxy:{IPv4Address:'172.19.0.2/16'}}};
  const native = {Id:'native',NetworkSettings:{Networks:{internal:{NetworkID:'internal',IPAddress:'172.18.0.2'}}}};
  const proxy = {Id:'proxy',NetworkSettings:{Networks:{internal:{NetworkID:'internal',IPAddress:'172.18.0.3'},egress:{NetworkID:'egress',IPAddress:'172.19.0.2'}}}};
  assert.deepEqual(proxyTopology(internal,egress,native,proxy), { nativeAddress:'172.18.0.2', listenAddress:'172.18.0.3' });
  assert.throws(() => proxyTopology({...internal,Containers:{...internal.Containers,worker:{IPv4Address:'172.18.0.4/16'}}},egress,native,proxy));
  assert.throws(() => proxyTopology(internal,{...egress,Containers:{...egress.Containers,other:{IPv4Address:'172.19.0.3/16'}}},native,proxy));
  assert.throws(() => proxyTopology(internal,egress,native,{...proxy,NetworkSettings:{Networks:{...proxy.NetworkSettings.Networks,internal:{NetworkID:'internal',IPAddress:'172.18.0.99'}}}}));
});

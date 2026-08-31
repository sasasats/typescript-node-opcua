import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { OpcUaClient, OpcUaConnectionError } from '../client/opc-ua-client';
import { NODE_IDS } from '../client/node-ids';
import { env } from '../config/env';

const TEST_NODE = NODE_IDS.fastUInt1;

describe('OPC UA device simulation', () => {
  let opcClient: OpcUaClient;

  beforeEach(() => {
    opcClient = new OpcUaClient(env.OPC_UA_ENDPOINT);
  });

  afterEach(async () => {
    await opcClient.disconnect().catch(() => {});
  });

  it('1. should connect to OPC UA server', async () => {
    await opcClient.connect();

    expect(opcClient.isConnected()).toBe(true);
  });

  it('2. should browse and discover required nodes', async () => {
    await opcClient.connect();

    // const discoveredNodes = await opcClient.browseRecursive();

    // console.log("Discovered nodes:", discoveredNodes);

    // expect(discoveredNodes).toContain(NODE_IDS.fastUInt1);

    // expect(discoveredNodes).toContain(NODE_IDS.fastUInt2);

    const fastFolder = await opcClient.browse('ns=3;s=Fast');
    const fastNodes = fastFolder.references?.map((r) => r.nodeId.toString()) ?? [];
    console.log('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    console.log(fastNodes);
    expect(fastNodes).toContain(NODE_IDS.fastUInt1);
  });

  it('3. should read live changing value', async () => {
    await opcClient.connect();

    const first = await opcClient.readNode(TEST_NODE);

    expect(first.value.value).toBeDefined();

    expect(typeof first.value.value).toBe('number');

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const second = await opcClient.readNode(TEST_NODE);

    expect(second.value.value).not.toBe(first.value.value);
  });

  it('4. should receive data change notification', async () => {
    await opcClient.connect();

    const notificationReceived = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, 10000);

      opcClient.subscribeToNode(
        TEST_NODE,

        () => {
          clearTimeout(timeout);

          resolve(true);
        },
      );
    });

    expect(await notificationReceived).toBe(true);
  });

  it('5. should handle connection failure gracefully', async () => {
    const badClient = new OpcUaClient(env.OPC_UA_ENDPOINT + '1');

    await expect(badClient.connect(3000)).rejects.toBeInstanceOf(OpcUaConnectionError);

    await badClient.disconnect().catch(() => {});
  });

  it('6. should cleanup session after disconnect', async () => {
    await opcClient.connect();

    expect(opcClient.isConnected()).toBe(true);

    await opcClient.disconnect();

    expect(opcClient.isConnected()).toBe(false);

    await expect(opcClient.readNode(TEST_NODE)).rejects.toThrow();
  });
});

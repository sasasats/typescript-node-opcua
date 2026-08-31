import {
  OPCUAClient,
  ClientSession,
  ClientSubscription,
  AttributeIds,
  TimestampsToReturn,
  ClientMonitoredItem,
  DataValue,
} from 'node-opcua';

export class OpcUaConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpcUaConnectionError';
  }
}

export class OpcUaClient {
  private client: OPCUAClient;
  private session?: ClientSession;

  private subscriptions: ClientSubscription[] = [];
  private monitoredItems: ClientMonitoredItem[] = [];

  constructor(private readonly endpoint: string) {
    this.client = OPCUAClient.create({
      endpointMustExist: false,
    });
  }

  async connect(timeoutMs = 10000): Promise<void> {
    let timeoutId: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        this.client.connect(this.endpoint),

        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new OpcUaConnectionError(`Connection timeout: ${this.endpoint}`));
          }, timeoutMs);
        }),
      ]);

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      this.session = await this.client.createSession();
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      await this.client.disconnect().catch(() => {});

      throw new OpcUaConnectionError(`Failed to connect to OPC UA server: ${(error as Error).message}`);
    }
  }

  isConnected(): boolean {
    return this.session !== undefined;
  }

  async readNode(nodeId: string): Promise<DataValue> {
    if (!this.session) {
      throw new Error('OPC UA session is not initialized');
    }

    return this.session.read({
      nodeId,

      attributeId: AttributeIds.Value,
    });
  }

  async browse(nodeId = 'RootFolder') {
    if (!this.session) {
      throw new Error('OPC UA session is not initialized');
    }

    return this.session.browse(nodeId);
  }

  async browseRecursive(nodeId = 'RootFolder', discoveredNodes: string[] = []): Promise<string[]> {
    const result = await this.getSession().browse(nodeId);

    for (const ref of result.references ?? []) {
      const currentNode = ref.nodeId.toString();

      console.log(`${ref.browseName.name} -> ${currentNode}`);

      discoveredNodes.push(currentNode);

      await this.browseRecursive(currentNode, discoveredNodes);
    }

    return discoveredNodes;
  }

  async subscribeToNode(nodeId: string, callback: (dataValue: DataValue) => void): Promise<ClientSubscription> {
    if (!this.session) {
      throw new Error('OPC UA session is not initialized');
    }

    const subscription = ClientSubscription.create(this.session, {
      requestedPublishingInterval: 1000,

      requestedLifetimeCount: 60,

      requestedMaxKeepAliveCount: 10,

      maxNotificationsPerPublish: 10,

      publishingEnabled: true,

      priority: 1,
    });

    this.subscriptions.push(subscription);

    const monitoredItem = ClientMonitoredItem.create(
      subscription,

      {
        nodeId,

        attributeId: AttributeIds.Value,
      },

      {
        samplingInterval: 500,

        discardOldest: true,

        queueSize: 10,
      },

      TimestampsToReturn.Both,
    );

    this.monitoredItems.push(monitoredItem);

    monitoredItem.on('changed', (dataValue: DataValue) => {
      callback(dataValue);
    });

    return subscription;
  }

  async disconnect(): Promise<void> {
    // close monitored items

    for (const item of this.monitoredItems) {
      try {
        await item.terminate();
      } catch {
        // ignore already terminated items
      }
    }

    this.monitoredItems = [];

    // close subscriptions

    for (const subscription of this.subscriptions) {
      try {
        await subscription.terminate();
      } catch {
        // ignore already terminated subscriptions
      }
    }

    this.subscriptions = [];

    // close session

    if (this.session) {
      try {
        await this.session.close();
      } catch {
        // ignore already closed session
      }
    }

    // disconnect transport

    try {
      await this.client.disconnect();
    } catch {
      // ignore already disconnected client
    }

    this.session = undefined;
  }

  private getSession(): ClientSession {
    if (!this.session) {
      throw new Error('OPC UA session is not initialized');
    }

    return this.session;
  }
}

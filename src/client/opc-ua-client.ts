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

/** Ошибка на уровне monitored item: узел не существует, недоступен, и т.п. */
export class OpcUaMonitoredItemError extends Error {
  constructor(
    public readonly nodeId: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpcUaMonitoredItemError';
  }
}

/** Результат подписки на узел: даёт доступ и к subscription, и к конкретному monitored item. */
export interface NodeSubscription {
  subscription: ClientSubscription;
  monitoredItem: ClientMonitoredItem;
  /** Отписаться именно от этого узла, не трогая остальные monitored items в этой же subscription. */
  unsubscribe: () => Promise<void>;
}

export type ConnectionState = 'disconnected' | 'connected' | 'reconnecting';

export class OpcUaClient {
  private client: OPCUAClient;
  private session?: ClientSession;

  private subscriptions: ClientSubscription[] = [];
  private monitoredItems: ClientMonitoredItem[] = [];

  private connectionState: ConnectionState = 'disconnected';

  constructor(private readonly endpoint: string) {
    this.client = OPCUAClient.create({
      endpointMustExist: false,
    });

    this.client.on('connection_lost', () => {
      this.connectionState = 'reconnecting';
    });
    this.client.on('connection_reestablished', () => {
      this.connectionState = 'connected';
    });

    this.client.on('close', () => {
      if (this.connectionState !== 'connected') return;
    });
  }

  /**
   * Подключается к серверу и открывает сессию.
   * Если сервер не отвечает за timeoutMs — считаем это фатальной ошибкой,
   * а не зависаем на дефолтном (обычно очень большом) таймауте библиотеки.
   */
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

      // Победил connect() — таймер больше не нужен, иначе он держит process живым лишний раз.
      clearTimeout(timeoutId);

      this.session = await this.client.createSession();
      this.connectionState = 'connected';
    } catch (error) {
      clearTimeout(timeoutId);

      // Если что-то пошло не так на любом из шагов — не оставляем клиент
      // в "полуподключенном" состоянии. Ошибку disconnect() тут игнорируем
      // намеренно: нам важна ИСХОДНАЯ причина сбоя, а не вторичная.
      await this.client.disconnect().catch(() => {});

      throw new OpcUaConnectionError(`Failed to connect to OPC UA server: ${(error as Error).message}`);
    }
  }

  /**
   * Внимание: это проверка "у нас есть объект сессии", а не "канал реально жив".
   * После обрыва сети session может формально существовать, но быть мёртвой —
   * для проверки реального состояния канала слушайте client.on('connection_lost' | 'connection_reestablished').
   */
  isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /** Ждать восстановления канала после обрыва, с таймаутом. */
  async waitForReconnect(timeoutMs = 15000): Promise<void> {
    if (this.connectionState === 'connected') return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('reconnect timeout')), timeoutMs);
      this.client.once('connection_reestablished', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async readNode(nodeId: string): Promise<DataValue> {
    return this.getSession().read({
      nodeId,
      attributeId: AttributeIds.Value,
    });
  }

  async browse(nodeId = 'RootFolder') {
    return this.getSession().browse(nodeId);
  }

  async browseRecursive(nodeId = 'RootFolder', discoveredNodes: string[] = []): Promise<string[]> {
    const result = await this.getSession().browse(nodeId);

    for (const ref of result.references ?? []) {
      const currentNode = ref.nodeId.toString();
      discoveredNodes.push(currentNode);
      await this.browseRecursive(currentNode, discoveredNodes);
    }

    return discoveredNodes;
  }

  /**
   * Подписывается на изменения одного узла.
   *
   * Важные решения по дизайну:
   * 1) Мы ЖДЁМ событие 'initialized' перед тем как вернуть управление вызывающему коду.
   *    Создание monitored item на сервере — асинхронный round-trip; без ожидания
   *    вызывающий код мог бы решить, что подписка уже активна, хотя сервер её
   *    ещё не подтвердил.
   * 2) Мы явно слушаем 'err' и превращаем его в отклонённый промис (или зовём onError).
   *    Без этого невалидный/недоступный nodeId просто НИЧЕГО не делает —
   *    ни callback не вызывается, ни исключение не летит, тест зависает до
   *    собственного таймаута и маскирует реальную причину.
   * 3) Возвращаем monitoredItem вместе с subscription, чтобы можно было
   *    отписаться от ОДНОГО узла, не убивая всю subscription целиком
   *    (актуально, когда на одной subscription висит несколько узлов).
   */
  async subscribeToNode(
    nodeId: string,
    onChange: (dataValue: DataValue) => void,
    onError?: (error: OpcUaMonitoredItemError) => void,
  ): Promise<NodeSubscription> {
    const session = this.getSession();

    const subscription = ClientSubscription.create(session, {
      requestedPublishingInterval: 1000,
      requestedLifetimeCount: 60,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 10,
      publishingEnabled: true,
      priority: 1,
    });
    this.subscriptions.push(subscription);

    // Сбои на уровне самой subscription (не конкретного узла) — например,
    // порванный транспорт, потерянные Publish-ответы и т.п. Без этого
    // такие сбои остаются видны только в debug-логах node-opcua.
    subscription.on('internal_error', (err) => {
      onError?.(new OpcUaMonitoredItemError(nodeId, `Subscription internal error: ${err.message}`));
    });

    const monitoredItem = ClientMonitoredItem.create(
      subscription,
      { nodeId, attributeId: AttributeIds.Value },
      { samplingInterval: 500, discardOldest: true, queueSize: 10 },
      TimestampsToReturn.Both,
    );
    this.monitoredItems.push(monitoredItem);

    // Дожидаемся подтверждения от сервера, что monitored item создан успешно,
    // либо явной ошибки (например, BadNodeIdUnknown для несуществующего узла).
    await new Promise<void>((resolve, reject) => {
      monitoredItem.once('initialized', resolve);
      monitoredItem.once('err', (message: string) => {
        reject(new OpcUaMonitoredItemError(nodeId, message));
      });
    });

    monitoredItem.on('changed', onChange);
    monitoredItem.on('err', (message: string) => {
      onError?.(new OpcUaMonitoredItemError(nodeId, message));
    });

    return {
      subscription,
      monitoredItem,
      unsubscribe: async () => {
        await monitoredItem.terminate().catch(() => {});
        this.monitoredItems = this.monitoredItems.filter((item) => item !== monitoredItem);
      },
    };
  }

  /**
   * Порядок важен: сначала monitored items, потом subscriptions, потом сессия,
   * потом транспорт. Каждый шаг обёрнут в try/catch, потому что к моменту
   * disconnect() часть объектов может быть уже терминирована сервером
   * (например, из-за истёкшего lifetime) — это не повод останавливать cleanup.
   */
  async disconnect(): Promise<void> {
    for (const item of this.monitoredItems) {
      await item.terminate().catch(() => {});
    }
    this.monitoredItems = [];

    for (const subscription of this.subscriptions) {
      await subscription.terminate().catch(() => {});
    }
    this.subscriptions = [];

    if (this.session) {
      await this.session.close().catch(() => {});
    }

    await this.client.disconnect().catch(() => {});

    this.session = undefined;
    this.connectionState = 'disconnected';
  }

  private getSession(): ClientSession {
    if (!this.session) {
      throw new Error('OPC UA session is not initialized');
    }
    return this.session;
  }
}

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { OpcUaClient, OpcUaConnectionError } from '../client/opc-ua-client';
import { NODE_IDS } from '../client/node-ids';
import { env } from '../config/env';
import { execSync } from 'node:child_process';

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

    const fastFolder = await opcClient.browse('ns=3;s=Fast');
    const fastNodes = fastFolder.references?.map((r) => r.nodeId.toString()) ?? [];

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

  it('7. should surface error for invalid node subscription', async () => {
    await opcClient.connect();

    const result = await new Promise<'changed' | 'error' | 'timeout'>((resolve) => {
      const timeout = setTimeout(() => resolve('timeout'), 5000);

      opcClient
        .subscribeToNode(NODE_IDS.nonExistent, () => {
          clearTimeout(timeout);
          resolve('changed');
        })
        .catch(() => {
          clearTimeout(timeout);
          resolve('error');
        });
    });

    expect(result).toBe('error');
  });

  it('8. should receive multiple sequential notifications (long-lived subscription)', async () => {
    await opcClient.connect();

    const received: number[] = [];

    await new Promise<void>((resolve, reject) => {
      opcClient
        .subscribeToNode(TEST_NODE, (dataValue) => {
          received.push(dataValue.value.value as number);
          if (received.length >= 3) resolve();
        })
        .catch(reject);

      setTimeout(() => reject(new Error('did not receive 3 notifications in time')), 15000);
    });

    expect(received.length).toBeGreaterThanOrEqual(3);
    expect(new Set(received).size).toBeGreaterThan(1);
  });

  it('9. should keep delivering notifications after malformed publish bursts', async () => {
    await opcClient.connect();

    const received: number[] = [];
    await new Promise<void>((resolve, reject) => {
      opcClient
        .subscribeToNode(NODE_IDS.badFastUInt1, (dv) => {
          received.push(dv.value.value as number);
        })
        .catch(reject);

      setTimeout(resolve, 15000);
    });

    // главное утверждение: поток не "умер" ПОСЛЕ сбоя — продолжаем получать данные
    expect(received.length).toBeGreaterThan(10);
  }, 18000);

  it('10. should recover subscription after real network drop', async () => {
    await opcClient.connect();

    const received: number[] = [];
    await opcClient.subscribeToNode(NODE_IDS.fastUInt1, (dv) => {
      received.push(dv.value.value as number);
    });

    // ждём первую валидную нотификацию до обрыва — убеждаемся, что поток вообще шёл
    await new Promise((r) => setTimeout(r, 1500));
    expect(received.length).toBeGreaterThan(0);

    // РЕАЛЬНЫЙ обрыв канала — не мок, а физическая остановка сервера
    execSync('npm run opcplc:stop');
    await new Promise((r) => setTimeout(r, 3000));
    execSync('npm run opcplc:start');

    // ждём, пока встроенный backoff-реконнект node-opcua восстановит канал
    await opcClient.waitForReconnect(20000);
    expect(opcClient.isConnected()).toBe(true);

    // после восстановления поток данных должен возобновиться сам,
    // без ручного пересоздания подписки
    received.length = 0;
    await new Promise((r) => setTimeout(r, 2000));
    expect(received.length).toBeGreaterThan(0);
  }, 40000);

  it('11. should allow a fresh subscription after a mid-test failure and cleanup', async () => {
    await opcClient.connect();
    await opcClient.subscribeToNode(NODE_IDS.fastUInt1, () => {});

    try {
      expect(1).toBe(2); // намеренный провал assert
    } catch {
      // тест продолжает выполняться, как будто мы упали и afterEach ещё не сработал
    }

    await opcClient.disconnect(); // ручной cleanup здесь, а не полагаемся только на afterEach

    // Главное: после disconnect клиент в чистом состоянии и готов к новому циклу —
    // никакая "утечка" из прерванного assert-а не мешает следующему подключению
    await opcClient.connect();
    const received: number[] = [];
    await opcClient.subscribeToNode(NODE_IDS.fastUInt1, (dv) => received.push(dv.value.value as number));

    await new Promise((r) => setTimeout(r, 2000));
    expect(received.length).toBeGreaterThan(0);
  }, 10000);

  it('12. should handle multiple independent subscriptions in parallel', async () => {
    await opcClient.connect();

    const fast: number[] = [];
    const slow: number[] = [];

    const fastSub = await opcClient.subscribeToNode(NODE_IDS.fastUInt1, (dv) => fast.push(dv.value.value as number));
    await opcClient.subscribeToNode(NODE_IDS.slowUInt1, (dv) => slow.push(dv.value.value as number));

    // slow-узел обновляется раз в ~10с (--sr=10 в docker-контейнере), поэтому
    // ждём минимум 11-12с, чтобы гарантированно поймать хотя бы один тик
    await new Promise((r) => setTimeout(r, 12000));

    expect(fast.length).toBeGreaterThan(0);
    expect(slow.length).toBeGreaterThan(0);
    expect(fast.length).toBeGreaterThan(slow.length);

    await fastSub.unsubscribe();
    fast.length = 0;
    slow.length = 0;

    // тот же интервал — иначе slow физически не успеет прислать новое значение
    await new Promise((r) => setTimeout(r, 12000));

    expect(fast.length).toBe(0);
    expect(slow.length).toBeGreaterThan(0);
  }, 30000); // таймаут теста тоже поднимаем — 2×12с ожидания + накладные расходы

  it('13. should discard oldest values when consumer is slower than producer', async () => {
    await opcClient.connect();

    const received: number[] = [];
    let processing = Promise.resolve();

    await opcClient.subscribeToNode(NODE_IDS.fastUInt1, (dv) => {
      // намеренно медленный consumer — цепочка промисов, а не await внутри колбэка
      processing = processing
        .then(() => new Promise((r) => setTimeout(r, 800)))
        .then(() => {
          received.push(dv.value.value as number);
        });
    });

    await new Promise((r) => setTimeout(r, 5000));
    await processing;

    // при discardOldest: true клиент не должен захлебнуться и упасть,
    // просто часть промежуточных значений будет потеряна
    expect(received.length).toBeGreaterThan(0);
  }, 15000);

  it('14. should handle a large number of concurrent subscriptions without degradation', async () => {
    await opcClient.connect();

    const results = await Promise.all(
      Array.from({ length: 50 }, () => opcClient.subscribeToNode(NODE_IDS.fastUInt1, () => {})),
    );

    expect(results.every((r) => r.monitoredItem !== undefined)).toBe(true);
  }, 20000);
});

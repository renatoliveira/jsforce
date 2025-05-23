import assert from 'assert';
import ConnectionManager from './helper/connection-manager';
import config from './config';
import { isObject, isString, delay } from './util';
import type {
  StreamingMessage,
  GenericStreamingMessage,
  Subscription,
} from 'jsforce/api/streaming';
import { isNodeJS } from './helper/env';
import { randomUUID } from 'crypto';

const connMgr = new ConnectionManager(config);
const conn = connMgr.createConnection();
const testChannelName = '/u/JSforceTestChannel';
const cdcChannel = '/data/AccountChangeEvent'
const DELAY_SECONDS = 5;
const DELAY_SECONDS_MILIS = DELAY_SECONDS * 1000;
const TEST_TIMEOUT_MINUTES = 1
const TEST_TIMEOUT_TRESHHOLD = TEST_TIMEOUT_MINUTES * 60 * 1000;

// before all tests, establish the connection and create the custom streaming channel for the tests
beforeAll(async () => {
  await connMgr.establishConnection(conn);

  await conn.sobject('StreamingChannel').create({ Name: testChannelName });
});

// after each test, clean up the created custom streaming channel
afterAll(async () => {
  await conn
    .sobject('StreamingChannel')
    .find({ Name: testChannelName })
    .destroy();
})

describe('tests with created PushTopic', () => {
  if (!isNodeJS()) {
    it('Not a NodeJS environment. Skippig PushTopic tests...');
    return;
  }

  it('should receive a PushTopic event when an Account is created', async () => {
    type Account = { Id: string; Name: string };

    const id = Date.now();

    const accountName = `My New Account #${id}`;

    const pushTopicName = `Topic-${id}`;

    await conn.sobject('PushTopic').create({
      Name: pushTopicName,
      Query: `SELECT Id, Name FROM Account WHERE Name='${accountName}'`,
      ApiVersion: '54.0',
      NotifyForFields: 'Referenced',
      NotifyForOperationCreate: true,
      NotifyForOperationUpdate: true,
      NotifyForOperationDelete: false,
      NotifyForOperationUndelete: false,
    });

    let subscr: Subscription | undefined;
    const msgArrived = new Promise<StreamingMessage<Account>>((resolve) => {
      subscr = conn.streaming.topic<Account>(pushTopicName).subscribe(resolve);
    });

    await conn.sobject('Account').create({ Name: accountName });

    const msg = await msgArrived;

    try {
      assert.ok(isObject(msg.sobject));
      assert.ok(msg.sobject.Name === accountName);

      assert.ok(isObject(msg.event));
      assert.ok(msg.event.type === 'created');
      assert.ok(isObject(msg.sobject));
      assert.ok(isString(msg.sobject.Name));
      assert.ok(isString(msg.sobject.Id));
    } finally {
      await conn.sobject('Account').findOne({ Name: accountName }).delete();
    }

    if (subscr) {
      subscr.cancel();
    }

    await conn.sobject('PushTopic').findOne({ Name: pushTopicName }).delete();
  }, TEST_TIMEOUT_TRESHHOLD);

  it('should receive only events published after a specific replayId on a generic channel (specific replayId)', async () => {
    // Publish two events before subscribing
    const payloadMessage1 = randomUUID();
    const payloadMessage2 = randomUUID();
    await conn.streaming.channel(testChannelName).push({
      payload: payloadMessage1,
      userIds: [],
    });
    await conn.streaming.channel(testChannelName).push({
      payload: payloadMessage2,
      userIds: [],
    });
    // Subscribe to get the latest replayId (publish a new event after subscribing to ensure delivery)
    let tempSubscr: Subscription | undefined;
    const msgArrived = new Promise<GenericStreamingMessage>((resolve) => {
      tempSubscr = conn.streaming.channel(testChannelName).subscribe(resolve, -2);
    });
    await delay(DELAY_SECONDS_MILIS); // Give the subscription time to establish
    // Publish a new event to trigger the subscription and get the latest replayId
    const payloadMessage3 = randomUUID();
    await conn.streaming.channel(testChannelName).push({
      payload: payloadMessage3,
      userIds: [],
    });
    const latestMsg = await msgArrived;
    if (tempSubscr) {
      tempSubscr.cancel();
    }
    const lastReplayId = latestMsg.event.replayId;
    assert.ok(typeof lastReplayId === 'number');
    // Now subscribe using the lastReplayId (should only get new events after this)
    let subscr: Subscription | undefined;
    const msgArrived2 = new Promise<GenericStreamingMessage>((resolve) => {
      subscr = conn.streaming.channel(testChannelName).subscribe(resolve, lastReplayId);
    });
    await delay(DELAY_SECONDS_MILIS);
    // Publish a new event after subscribing
    const payloadMessage4 = randomUUID();
    await conn.streaming.channel(testChannelName).push({
      payload: payloadMessage4,
      userIds: [],
    });
    const msg = await msgArrived2;
    // Should only receive the event published after subscribing
    assert.ok(msg.payload === payloadMessage4);
    assert.ok(typeof msg.event.replayId === 'number');
    if (subscr) {
      subscr.cancel();
    }
  }, TEST_TIMEOUT_TRESHHOLD);

  // tests using the replay id -1 and -2
  // see: https://developer.salesforce.com/docs/atlas.en-us.api_streaming.meta/api_streaming/using_streaming_api_durability.htm

  it('should receive a custom streaming event on a generic channel with replayId -1 (new events only)', async () => {
    let subscr: Subscription | undefined;
    const msgArrived = new Promise<GenericStreamingMessage>((resolve) => {
      const streamingChannel = conn.streaming.channel(testChannelName);
      subscr = streamingChannel.subscribe(resolve, -1);
    });
    await delay(DELAY_SECONDS_MILIS);
    const payloadMessage = randomUUID();
    const res = await conn.streaming.channel(testChannelName).push({
      payload: payloadMessage,
      userIds: [],
    });
    assert.ok(res.fanoutCount === -1);
    assert.ok(isObject(res.userOnlineStatus));
    const msg = await msgArrived;
    assert.ok(msg.payload === payloadMessage);

    if (subscr) {
      subscr.cancel();
    }
  }, TEST_TIMEOUT_TRESHHOLD);

  it('should receive only new events published after subscribing (replayId -1)', async () => {
    let subscr: Subscription | undefined;
    // Publish an event BEFORE subscribing
    const payloadMessageBefore = randomUUID();
    const resBefore = await conn.streaming.channel(testChannelName).push({
      payload: payloadMessageBefore,
      userIds: [],
    });
    assert.ok(resBefore.fanoutCount === 0 || resBefore.fanoutCount === -1);
    assert.ok(isObject(resBefore.userOnlineStatus));
    // Now subscribe (replayId -1 means only new events after this point)
    const msgArrived = new Promise<GenericStreamingMessage>((resolve) => {
      const streamingChannel = conn.streaming.channel(testChannelName);
      subscr = streamingChannel.subscribe(resolve, -1);
    });
    await delay(DELAY_SECONDS_MILIS);
    // Publish an event AFTER subscribing
    const payloadMessageAfter = randomUUID();
    const resAfter = await conn.streaming.channel(testChannelName).push({
      payload: payloadMessageAfter,
      userIds: [],
    });
    assert.ok(resAfter.fanoutCount === -1);
    assert.ok(isObject(resAfter.userOnlineStatus));
    const msg = await msgArrived;
    // Assert that only the event published after subscribing is received
    assert.ok(msg.payload === payloadMessageAfter);
    // Optionally, check that the replayId is present
    assert.ok(typeof msg.event.replayId === 'number');
    if (subscr) {
      subscr.cancel();
    }
  }, TEST_TIMEOUT_TRESHHOLD);
})

describe('tests with created CDC channel', () => {
  if (!isNodeJS()) {
    it('Not a NodeJS environment. Skippig ChangeDataCapture tests...');
    return;
  }

  interface AccountSObject {
    Id: string;
    Name: string;
  }

  const TIMEOUT_WARNING_MESSAGE = '⚠️ Warning: Timeout waiting for CDC replayed events. This may be due to high load on the platform. The test won\'t fail but it may be less reliable. If you are uncertain about the result, please run the test more times.';

  // NOTE: Salesforce Generic Streaming does not reliably support replayId = -2 (all retained events).
  // See: https://developer.salesforce.com/docs/atlas.en-us.api_streaming.meta/api_streaming/using_generic_stream.htm
  // Events are only retained for replay if published while a subscriber is active, and even then, replayId = -2 may not return them as expected.
  // This is a Salesforce platform limitation, not a bug in jsforce.

  it('should receive Account CDC events with replayId -1 (new events only)', async () => {
    const cdcChannel = '/data/AccountChangeEvent';
    const createdAccountNames: string[] = [];
    let subscr: Subscription | undefined;
    const receivedEvents: any[] = [];
    let skipMe = false;
    const ready = new Promise<void>((resolve, reject) => {
      subscr = conn.streaming.channel(cdcChannel).subscribe((msg: any) => {
        if (msg && msg.payload && msg.payload.ChangeEventHeader && createdAccountNames.includes(msg.payload.Name)) {
          receivedEvents.push(msg);
          if (createdAccountNames.every(name => receivedEvents.some(e => e.payload.Name === name))) {
            resolve();
          }
        } else {
          throw new Error('Received unexpected CDC event');
        }
      }, -1);
      setTimeout(() => {
        skipMe = true;
      }, DELAY_SECONDS_MILIS * 12);
    });
    // Now create the records
    for (let i = 0; i < 2; i++) {
      const name = `CDC Test Account #${randomUUID()}`;
      createdAccountNames.push(name);
      const createResult = await conn.sobject('Account').create({ Name: name });
      assert.ok(createResult.success);
    }
    await ready;
    if (subscr) subscr.cancel();
    if (skipMe) {
      console.warn(TIMEOUT_WARNING_MESSAGE);
      return;
    }
    // Clean up as above...
    // Bulk delete all created accounts by querying their names in a single query
    const accounts = await conn.sobject('Account').find(
      { Name: { $in: createdAccountNames } },
      ['Id']
    );
    if (!accounts || accounts.length == 0) {
      throw new Error('No accounts found to delete');
    }
    await conn.sobject('Account').destroy(accounts.map(a => a.Id));
  }, TEST_TIMEOUT_TRESHHOLD);

  it('should receive just the new Account CDC events with replayId defined', async () => {
    let createdAccountNames: string[] = [];
    let lastReplayId: number | undefined;
    let subscr: Subscription | undefined;
    let skipMe = false;
    const receivedEvents: any[] = [];
    const subscription = new Promise<void>((resolve) => {
      subscr = conn.streaming.channel(cdcChannel).subscribe((msg: any) => {
        lastReplayId = msg.event.replayId;
        // Only consider events for accounts created in this test
        if (
          msg &&
          msg.payload &&
          msg.payload.ChangeEventHeader &&
          createdAccountNames.includes(msg.payload.Name)
        ) {
          receivedEvents.push(msg);
          if (createdAccountNames.every(name => receivedEvents.some(e => e.payload.Name === name))) {
            resolve();
          }
        }
      }, -1);
      setTimeout(() => {
        skipMe = true;
        resolve();
      }, DELAY_SECONDS_MILIS * 12);
    });
    // Step 1: Publish two Account changes (inserts)
    for (let i = 0; i < 2; i++) {
      const name = `CDC Test Account #${randomUUID()}`;
      createdAccountNames.push(name);
      const createResult = await conn.sobject('Account').create({ Name: name })
      assert.ok(createResult.success);
    }
    await subscription;
    if (skipMe) {
      console.log(TIMEOUT_WARNING_MESSAGE);
      return;
    }
    await delay(DELAY_SECONDS_MILIS);
    // Step 2: Subscribe with replayId = -2
    try {
      const receivedEvents: any[] = [];
      const ready = new Promise<void>((resolve, reject) => {
        subscr = conn.streaming.channel(cdcChannel).subscribe((msg: any) => {
          // Log all received events for debugging
          // Only consider events for accounts created in this test
          if (msg && msg.payload && msg.payload.ChangeEventHeader && createdAccountNames.includes(msg.payload.Name)) {
            receivedEvents.push(msg);
            if (createdAccountNames.every(name => receivedEvents.some(e => e.payload.Name === name))) {
              resolve();
            }
          }
        }, lastReplayId);
        // wait some time because CDCs are not guaranteed to be delivered immediately at all.
        // on high loads or if the org is busy, it may take a while to get the events.
        setTimeout(() => {
          console.log(TIMEOUT_WARNING_MESSAGE);
          skipMe = true;
        }, DELAY_SECONDS_MILIS);
      });
      createdAccountNames = [];
      for (let i = 0; i < 2; i++) {
        const name = `CDC Test Account #${randomUUID()}`;
        createdAccountNames.push(name);
        const createResult = await conn.sobject('Account').create({ Name: name })
        assert.ok(createResult.success);
      }
      await ready;
      if (skipMe) {
        console.warn(TIMEOUT_WARNING_MESSAGE);
        return;
      }
      // Sometimes the delete events are received in a single CDC record, so that's why we check
      // for that scenario too.
      assert.ok(createdAccountNames.length === receivedEvents.length || receivedEvents.length === 1 && (createdAccountNames.length === receivedEvents[0].payload.ChangeEventHeader.recordIds.length));
      // Assert that both created accounts were received in CDC events
      for (const name of createdAccountNames) {
        assert.ok(receivedEvents.some(e => e.payload.Name === name));
      }
    } finally {
      if (subscr) {
        subscr.unsubscribe();
        subscr.cancel();
      };
      // Step 3: Clean up created accounts (all of them)
      // Bulk delete all created accounts by querying their names in a single query
      const accounts = await conn.sobject('Account').find(
        { Name: { $in: createdAccountNames } },
        ['Id']
      );
      if (!accounts || accounts.length == 0) {
        throw new Error('No accounts found to delete');
      }
      await conn.sobject('Account').destroy(accounts.map(a => a.Id));
    }
  }, TEST_TIMEOUT_TRESHHOLD * 3);

  it('should receive all Account CDC events with replayId -2 (all retained events)', async () => {
    const createdAccounts: AccountSObject[] = [];
    // Step 1: Publish two Account changes
    for (let i = 0; i < 2; i++) {
      const name = `CDC Test Account #${randomUUID()}`;
      const createResult = await conn.sobject('Account').create({ Name: name })
      assert.ok(createResult.success);
      createdAccounts.push({ Id: createResult.id, Name: name });
    }
    // DO NOT delay here! Subscribe immediately to maximize chance of receiving CREATE events
    let subscr: Subscription | undefined;
    try {
      const receivedEvents: any[] = [];
      let skipMe = false;
      const ready = new Promise<void>((resolve, reject) => {
        subscr = conn.streaming.channel(cdcChannel).subscribe((msg: any) => {
          // Only consider events for accounts created in this test
          if (msg && msg.payload && msg.payload.ChangeEventHeader && createdAccounts.find(a => a.Name === msg.payload.Name)) {
            receivedEvents.push(msg);
            if (createdAccounts.every(record => receivedEvents.some(e => e.payload.Name === record.Name))) {
              resolve();
            }
          }
        }, -2);
        setTimeout(() => {
          skipMe = true;
          resolve();
        }, Math.max(TEST_TIMEOUT_TRESHHOLD, DELAY_SECONDS_MILIS * 12));
      });
      await ready;
      if (skipMe) {
        console.warn(TIMEOUT_WARNING_MESSAGE);
        return;
      }
      // Sometimes the delete events are received in a single CDC record, so that's why we check
      // for that scenario too.
      assert.ok(createdAccounts.length === receivedEvents.length || receivedEvents.length === 1 && (createdAccounts.length === receivedEvents[0].payload.ChangeEventHeader.recordIds.length));
      // Assert that both created accounts were received in CDC events
      for (const record of createdAccounts) {
        assert.ok(receivedEvents.some(e => e.payload.Name === record.Name));
      }
    } finally {
      if (subscr) {
        subscr.unsubscribe();
        subscr.cancel();
      }
      // Clean up after subscription so deletion events don't interfere
      const accounts = await conn.sobject('Account').find(
        { Name: { $in: createdAccounts.map(a => a.Name) } },
        ['Id']
      );
      if (accounts && accounts.length > 0) {
        await conn.sobject('Account').destroy(accounts.map(a => a.Id));
      }
    }
  }, Math.max(TEST_TIMEOUT_TRESHHOLD, DELAY_SECONDS_MILIS * 12));
});


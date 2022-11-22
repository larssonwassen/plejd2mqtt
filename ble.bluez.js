const dbus = require('dbus-next');
const crypto = require('crypto');
const xor = require('buffer-xor');
const _ = require('lodash');
const EventEmitter = require('events');

let debug = 'console';

const getLogger = () => {
  const consoleLogger = msg => console.log('plejd-ble', msg);
  if (debug === 'console') {
    return consoleLogger;
  }

  // > /dev/null
  return _.noop;
};

const logger = getLogger();

// UUIDs
const PLEJD_SERVICE = '31ba0001-6085-4726-be45-040c957391b5';
const DATA_UUID = '31ba0004-6085-4726-be45-040c957391b5';
const LAST_DATA_UUID = '31ba0005-6085-4726-be45-040c957391b5';
const AUTH_UUID = '31ba0009-6085-4726-be45-040c957391b5';
const PING_UUID = '31ba000a-6085-4726-be45-040c957391b5';

const BLE_CMD_DIM_CHANGE = '00c8';
const BLE_CMD_DIM2_CHANGE = '0098';
const BLE_CMD_STATE_CHANGE = '0097';
const BLE_CMD_SCENE_TRIG = '0021';

const BLUEZ_SERVICE_NAME = 'org.bluez';
const DBUS_OM_INTERFACE = 'org.freedesktop.DBus.ObjectManager';
const DBUS_PROP_INTERFACE = 'org.freedesktop.DBus.Properties';

const BLUEZ_ADAPTER_ID = 'org.bluez.Adapter1';
const BLUEZ_DEVICE_ID = 'org.bluez.Device1';
const GATT_SERVICE_ID = 'org.bluez.GattService1';
const GATT_CHRC_ID = 'org.bluez.GattCharacteristic1';

class PlejdService extends EventEmitter {
  constructor(cryptoKey, devices, sceneManager, connectionTimeout, writeQueueWaitTime, keepAlive = false) {
    super();

    this.cryptoKey = Buffer.from(cryptoKey.replace(/-/g, ''), 'hex');

    this.sceneManager = sceneManager;
    this.connectedDevice = null;
    this.plejdService = null;
    this.bleDevices = [];
    this.plejdDevices = {};
    this.devices = devices;
    this.connectEventHooked = false;
    this.connectionTimeout = connectionTimeout;
    this.writeQueueWaitTime = writeQueueWaitTime;
    this.writeQueue = [];
    this.writeQueueRef = null;

    // Holds a reference to all characteristics
    this.characteristics = {
      data: null,
      lastData: null,
      lastDataProperties: null,
      auth: null,
      ping: null
    };

    this.bus = dbus.systemBus();
    this.adapter = null;

    logger('wiring events and waiting for BLE interface to power up.');
    this.wireEvents();
  }

  async init() {
    if (this.objectManager) {
      this.objectManager.removeAllListeners();
    }

    this.connectedDevice = null;
    this.bleDevices = [];
    this.characteristics = {
      data: null,
      lastData: null,
      lastDataProperties: null,
      auth: null,
      ping: null
    };

    clearInterval(this.pingRef);
    clearInterval(this.writeQueueRef);
    console.log('init()');

    const bluez = await this.bus.getProxyObject(BLUEZ_SERVICE_NAME, '/');
    this.objectManager = await bluez.getInterface(DBUS_OM_INTERFACE);

    // We need to find the ble interface which implements the Adapter1 interface
    const managedObjects = await this.objectManager.GetManagedObjects();
    let result = await this._getInterface(managedObjects, BLUEZ_ADAPTER_ID);

    if (result) {
      this.adapter = result[1];
    }

    if (!this.adapter) {
      console.log('plejd-ble: error: unable to find a bluetooth adapter that is compatible.');
      return;
    }

    for (let path of Object.keys(managedObjects)) {
      const interfaces = Object.keys(managedObjects[path]);

      if (interfaces.indexOf(BLUEZ_DEVICE_ID) > -1) {
        const proxyObject = await this.bus.getProxyObject(BLUEZ_SERVICE_NAME, path);
        const device = await proxyObject.getInterface(BLUEZ_DEVICE_ID);

        const connected = managedObjects[path][BLUEZ_DEVICE_ID].Connected.value;

        if (connected) {
          console.log('plejd-ble: disconnecting ' + path);
          await device.Disconnect();
        }

        await this.adapter.RemoveDevice(path);
      }
    }

    this.objectManager.on('InterfacesAdded', this.onInterfacesAdded.bind(this));

    this.adapter.SetDiscoveryFilter({
      'UUIDs': new dbus.Variant('as', [PLEJD_SERVICE]),
      'Transport': new dbus.Variant('s', 'le')
    });

    try {
      await this.adapter.StartDiscovery();
    } catch (err) {
      console.log('plejd-ble: error: failed to start discovery. Make sure no other add-on is currently scanning.');
      return;
    }

    setTimeout(async () => {
      await this._internalInit();
    }, this.connectionTimeout * 1000);
  }

  async _internalInit() {
    logger('got ' + this.bleDevices.length + ' device(s).');

    for (const plejd of this.bleDevices) {
      logger('inspecting ' + plejd['path']);

      try {
        const proxyObject = await this.bus.getProxyObject(BLUEZ_SERVICE_NAME, plejd['path']);
        const device = await proxyObject.getInterface(BLUEZ_DEVICE_ID);
        const properties = await proxyObject.getInterface(DBUS_PROP_INTERFACE);

        plejd['rssi'] = (await properties.Get(BLUEZ_DEVICE_ID, 'RSSI')).value;
        plejd['instance'] = device;

        const segments = plejd['path'].split('/');
        let fixedPlejdPath = segments[segments.length - 1].replace('dev_', '');
        fixedPlejdPath = fixedPlejdPath.replace(/_/g, '');
        plejd['device'] = this.devices.find(x => x.serialNumber === fixedPlejdPath);

        logger('discovered ' + plejd['path'] + ' with rssi ' + plejd['rssi']);
      } catch (err) {
        console.log('plejd-ble: failed inspecting ' + plejd['path'] + ' error: ' + err);
      }
    }

    const sortedDevices = this.bleDevices.sort((a, b) => b['rssi'] - a['rssi']);
    let connectedDevice = null;

    for (const plejd of sortedDevices) {
      try {
        if (plejd['instance']) {
          console.log('plejd-ble: connecting to ' + plejd['path']);
          await plejd['instance'].Connect();
          connectedDevice = plejd;
          break
        }
      } catch (err) {
        console.log('plejd-ble: warning: unable to connect, will retry. ' + err);
      }
    }

    setTimeout(async () => {
      await this.onDeviceConnected(connectedDevice);
      await this.adapter.StopDiscovery();
    }, this.connectionTimeout * 1000);
  }

  async _getInterface(managedObjects, iface) {
    const managedPaths = Object.keys(managedObjects);

    for (let path of managedPaths) {
      const pathInterfaces = Object.keys(managedObjects[path]);
      if (pathInterfaces.indexOf(iface) > -1) {
        logger('found ble interface \'' + iface + '\' at ' + path);
        try {
          const adapterObject = await this.bus.getProxyObject(BLUEZ_SERVICE_NAME, path);
          return [path, adapterObject.getInterface(iface), adapterObject];
        } catch (err) {
          console.log('plejd-ble: error: failed to get interface \'' + iface + '\': ' + err);
        }
      }
    }

    return null;
  }

  async onInterfacesAdded(path, interfaces) {
    const [adapter, dev, service, characteristic] = path.split('/').slice(3);
    const interfaceKeys = Object.keys(interfaces);

    if (interfaceKeys.indexOf(BLUEZ_DEVICE_ID) > -1) {
      if (interfaces[BLUEZ_DEVICE_ID]['UUIDs'].value.indexOf(PLEJD_SERVICE) > -1) {
        logger('found Plejd service on ' + path);
        this.bleDevices.push({
          'path': path
        });
      } else {
        console.log('uh oh, no Plejd device.');
      }
    }
  }

  updateSettings(settings) {
    if (settings.debug) {
      debug = 'console';
    } else {
      debug = '';
    }
  }

  createPayload(deviceId, cmd, data = null) {
    let payloadStr = (deviceId).toString(16).padStart(2, '0') + cmd
    if (data != null) {
      payloadStr += data.toString(16).padStart(4, '0')
    }
    return Buffer.from(payloadStr, 'hex');
  }

  turnOn(id, command) {
    logger(`Turn on device ${id}.` + (command.brightness != null ? `Brightness: ${command.brightness}` : ''));

    let payload;
    if (command.brightness == null) {
      payload = this.createPayload(id, '0110009701');
    } else {
      const hByte = (command.brightness << 8) & 0xFF00;
      const lByte = (command.brightness & 0x00FF);
      payload = this.createPayload(id, '0110009801', (hByte | lByte) & 0xFFFF);
    }
    this.writeQueue.unshift(payload);
  }

  turnOff(id, command) {
    logger(`Turn off device ${id}`);

    this.writeQueue.unshift(
      this.createPayload(id, '0110009700')
    );
  }

  triggerScene(sceneIndex) {
    console.log('triggering scene with ID ' + sceneIndex);
    this.sceneManager.executeScene(sceneIndex, this);
  }

  async authenticate() {
    console.log('authenticate()');
    try {
      await this.characteristics.auth.WriteValue([0], {});
      const challenge = await this.characteristics.auth.ReadValue({});
      const response = this._createChallengeResponse(this.cryptoKey, Buffer.from(challenge));
      await this.characteristics.auth.WriteValue([...response], {});
    } catch (err) {
      console.log('plejd-ble: error: failed to authenticate: ' + err);
    }

    // auth done, start ping
    await this.startPing();
    await this.startWriteQueue();

    // After we've authenticated, we need to hook up the event listener
    // for changes to lastData.
    this.characteristics.lastDataProperties.on('PropertiesChanged', this.onLastDataUpdated.bind(this));
    this.characteristics.lastData.StartNotify();
  }

  async write(data, retry = true) {
    if (!this.plejdService || !this.characteristics.data) {
      return;
    }

    try {
      console.log('plejd-ble: sending ' + data.length + ' byte(s) of data to Plejd');
      const encryptedData = this._encryptDecrypt(this.cryptoKey, this.plejdService.addr, data);
      await this.characteristics.data.WriteValue([...encryptedData], {});
    } catch (err) {
      if (err.message === 'In Progress') {
        setTimeout(() => this.write(data, retry), 1000);
        return;
      }

      console.log('plejd-ble: write failed ' + err);
      setTimeout(async () => {
        await this.init();

        if (retry) {
          logger('reconnected and retrying to write');
          await this.write(data, false);
        }
      }, this.connectionTimeout * 1000);
    }
  }

  async startPing() {
    console.log('start Ping <> Pong');
    clearInterval(this.pingRef);

    this.pingRef = setInterval(async () => {
      // logger('ping');
      await this.ping();
    }, 3000);
  }

  onPingSuccess(nr) {
    // logger('pong: ' + nr);
  }

  async onPingFailed(error) {
    logger('onPingFailed(' + error + ')');
    console.log('plejd-ble: ping failed, reconnecting.');

    clearInterval(this.pingRef);
    await this.init();
  }

  async ping() {
    // logger('ping()');

    var ping = crypto.randomBytes(1);
    let pong = null;

    try {
      await this.characteristics.ping.WriteValue([...ping], {});
      pong = await this.characteristics.ping.ReadValue({});
    } catch (err) {
      console.log('error: writing to plejd: ' + err);
      this.emit('pingFailed', 'write error');
      return;
    }

    if (((ping[0] + 1) & 0xff) !== pong[0]) {
      console.log('error: plejd ping failed');
      this.emit('pingFailed', 'plejd ping failed ' + ping[0] + ' - ' + pong[0]);
      return;
    }

    this.emit('pingSuccess', pong[0]);
  }

  async startWriteQueue() {
    console.log('startWriteQueue()');
    clearInterval(this.writeQueueRef);

    this.writeQueueRef = setTimeout(() => this.runWriteQueue(), this.writeQueueWaitTime);
  }

  async runWriteQueue() {
    while (this.writeQueue.length > 0) {
      const data = this.writeQueue.pop();
      await this.write(data, true);
    }

    this.writeQueueRef = setTimeout(() => this.runWriteQueue(), this.writeQueueWaitTime);
  }

  async _processPlejdService(path, characteristics) {
    const proxyObject = await this.bus.getProxyObject(BLUEZ_SERVICE_NAME, path);
    const service = await proxyObject.getInterface(GATT_SERVICE_ID);
    const properties = await proxyObject.getInterface(DBUS_PROP_INTERFACE);

    const uuid = (await properties.Get(GATT_SERVICE_ID, 'UUID')).value;
    if (uuid !== PLEJD_SERVICE) {
      console.log('plejd-ble: not a Plejd device.');
      return null;
    }

    const dev = (await properties.Get(GATT_SERVICE_ID, 'Device')).value;
    const regex = /dev_([0-9A-F_]+)$/;
    const dirtyAddr = regex.exec(dev);
    const addr = this._reverseBuffer(
      Buffer.from(
        String(dirtyAddr[1])
        .replace(/\-/g, '')
        .replace(/\_/g, '')
        .replace(/\:/g, ''), 'hex'
      )
    );

    for (const chPath of characteristics) {
      const chProxyObject = await this.bus.getProxyObject(BLUEZ_SERVICE_NAME, chPath);
      const ch = await chProxyObject.getInterface(GATT_CHRC_ID);
      const prop = await chProxyObject.getInterface(DBUS_PROP_INTERFACE);

      const chUuid = (await prop.Get(GATT_CHRC_ID, 'UUID')).value;

      if (chUuid === DATA_UUID) {
        logger('found DATA characteristic.');
        this.characteristics.data = ch;
      } else if (chUuid === LAST_DATA_UUID) {
        logger('found LAST_DATA characteristic.');
        this.characteristics.lastData = ch;
        this.characteristics.lastDataProperties = prop;
      } else if (chUuid === AUTH_UUID) {
        logger('found AUTH characteristic.');
        this.characteristics.auth = ch;
      } else if (chUuid === PING_UUID) {
        logger('found PING characteristic.');
        this.characteristics.ping = ch;
      }
    }

    return {
      addr: addr
    };
  }

  async onDeviceConnected(device) {
    console.log('onDeviceConnected()');

    const objects = await this.objectManager.GetManagedObjects();
    const paths = Object.keys(objects);
    let characteristics = [];

    for (const path of paths) {
      const interfaces = Object.keys(objects[path]);
      if (interfaces.indexOf(GATT_CHRC_ID) > -1) {
        characteristics.push(path);
      }
    }

    for (const path of paths) {
      const interfaces = Object.keys(objects[path]);
      if (interfaces.indexOf(GATT_SERVICE_ID) > -1) {
        let chPaths = [];
        for (const c of characteristics) {
          if (c.startsWith(path + '/')) {
            chPaths.push(c);
          }
        }

        console.log('trying ' + chPaths.length + ' characteristics');

        this.plejdService = await this._processPlejdService(path, chPaths);
        if (this.plejdService) {
          break;
        }
      }
    }

    if (!this.plejdService) {
      console.log('plejd-ble: warning: wasn\'t able to connect to Plejd, will retry.');
      this.emit('connectFailed');
      return;
    }

    if (!this.characteristics.auth) {
      console.log('plejd-ble: error: unable to enumerate characteristics.');
      this.emit('connectFailed');
      return;
    }

    this.connectedDevice = device['device'];
    await this.authenticate();
  }

  async onLastDataUpdated(iface, properties, invalidated) {
    if (iface !== GATT_CHRC_ID) {
      return;
    }

    const changedKeys = Object.keys(properties);
    if (changedKeys.length === 0) {
      return;
    }

    const value = await properties['Value'];
    if (!value) {
      return;
    }

    const decoded = this._encryptDecrypt(this.cryptoKey, this.plejdService.addr, value.value);
    if (decoded.length < 5) {
      // ignore the notification since too small
      return;
    }

    let device = parseInt(decoded[0], 10);
    const cmd = decoded.toString('hex', 3, 5);
    if (cmd === BLE_CMD_DIM_CHANGE || cmd === BLE_CMD_DIM2_CHANGE) {
      const state = parseInt(decoded.toString('hex', 5, 6), 10);
      const brightness = parseInt(decoded.toString('hex', 6, 8), 16) >> 8;
      this.emit('stateChanged', device, { state, brightness });
    } else if (cmd === BLE_CMD_STATE_CHANGE) {
      const state = parseInt(decoded.toString('hex', 5, 6), 10);
      this.emit('stateChanged', device, { state });
    } else if (cmd === BLE_CMD_SCENE_TRIG) {
      const scene = parseInt(decoded.toString('hex', 5, 6), 10);
      this.emit('sceneTriggered', device, scene);
    }

  }

  wireEvents() {
    console.log('wireEvents()');
    const self = this;

    this.on('pingFailed', this.onPingFailed.bind(self));
    this.on('pingSuccess', this.onPingSuccess.bind(self));
  }

  _createChallengeResponse(key, challenge) {
    const intermediate = crypto.createHash('sha256').update(xor(key, challenge)).digest();
    const part1 = intermediate.subarray(0, 16);
    const part2 = intermediate.subarray(16);

    const resp = xor(part1, part2);

    return resp;
  }

  _encryptDecrypt(key, addr, data) {
    var buf = Buffer.concat([addr, addr, addr.subarray(0, 4)]);

    var cipher = crypto.createCipheriv("aes-128-ecb", key, '');
    cipher.setAutoPadding(false);

    var ct = cipher.update(buf).toString('hex');
    ct += cipher.final().toString('hex');
    ct = Buffer.from(ct, 'hex');

    var output = "";
    for (var i = 0, length = data.length; i < length; i++) {
      output += String.fromCharCode(data[i] ^ ct[i % 16]);
    }

    return Buffer.from(output, 'ascii');
  }

  _reverseBuffer(src) {
    var buffer = Buffer.allocUnsafe(src.length)

    for (var i = 0, j = src.length - 1; i <= j; ++i, --j) {
      buffer[i] = src[j]
      buffer[j] = src[i]
    }

    return buffer
  }
}

module.exports = PlejdService;

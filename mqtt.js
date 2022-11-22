const EventEmitter = require('events');
const mqtt = require('mqtt');
const _ = require('lodash');

const startTopic = 'homeassistant/status';

// #region logging
let debug = 'console';

const getLogger = () => {
  const consoleLogger = msg => console.log('plejd-mqtt', msg);
  if (debug === 'console') {
    return consoleLogger;
  }
  return _.noop;
};

const logger = getLogger();
// #endregion

// #region discovery

const discoveryPrefix = 'homeassistant';

const getSubscribePath = () => 'homeassistant/+/plejd/#';

const getPath = ({ id, type }) => `homeassistant/${type}/plejd/${id}`;
const getConfigPath = (plug) => `${getPath(plug)}/config`;
const getStateTopic = (device) => `${getPath(device)}/state`
const getCommandTopic = (device) => `${getPath(device)}/set`
const getAvailabilityTopic = (device) => `${getPath(device)}/availability`
const getSceneEventTopic = () => `plejd/event/scene`;
const getSettingsTopic = () => `plejd/settings`;

const getDiscoveryPayload = device => {
  const nameParts = []
  if (device.room?.title) {
    nameParts.push(device.room.title)
  }
  nameParts.push(device.name)
  const name = nameParts.join(' ')

  if (device.type == 'scene') {
    return {
      schema: 'json',
      name,
      unique_id: `plejd.scene.${device.id}`,
      object_id: `plejd_scene_${device.id}`,
      command_topic: getCommandTopic(device),
      availability: {
        topic: getAvailabilityTopic(device),
      },
      optimistic: false,
    }
  }

  const payload = {
    schema: 'json',
    name,
    unique_id: `plejd.${device.serialNumber}.${device.outputIndex}`,
    object_id: `plejd_${device.serialNumber}_${device.outputIndex}`,
    state_topic: getStateTopic(device),
    command_topic: getCommandTopic(device),
    availability: {
      topic: getAvailabilityTopic(device),
    },
    optimistic: false,
    device: {
      identifiers: device.serialNumber,
      manufacturer: 'Plejd',
      model: device.typeName,
      name: device.serialNumber,
      sw_version: device.version,
      suggested_area: device.room?.title,
    }
  }
  if (device.type === 'switch') {
    payload.value_template = '{{ value_json.state }}'
  } else {
    payload.brightness_value_template = '{{ value_json.brightness }}'
    payload.state_value_template = '{{ value_json.state }}'
    payload.brightness = device.dimmable
  }
  return payload
};

// const getSwitchPayload = device => ({
//   name: device.room?.title ? `${device.room.title} ${device.name}` : device.name,
//   state_topic: getStateTopic(device),
//   command_topic: getCommandTopic(device),
//   optimistic: false,
//   device: {
//     identifiers: device.serialNumber + '_' + device.id,
//     manufacturer: 'Plejd',
//     model: device.typeName,
//     name: device.name,
//     sw_version: device.version
//   }
// });

// #endregion

class MqttClient extends EventEmitter {
  constructor(mqttBroker, username, password) {
    super();

    this.mqttBroker = mqttBroker;
    this.username = username;
    this.password = password;
    this.deviceMap = {};
    this.devices = [];
  }

  init() {
    const self = this;

    this.client = mqtt.connect(this.mqttBroker, {
      username: this.username,
      password: this.password
    });

    this.client.on('connect', () => {
      logger('connected to MQTT.');

      this.client.subscribe(startTopic, (err) => {
        if (err) {
          logger('error: unable to subscribe to ' + startTopic);
        }

        self.emit('connected');
      });

      this.client.subscribe(getSubscribePath(), (err) => {
        if (err) {
          logger('error: unable to subscribe to control topics');
        }
      });

      this.client.subscribe(getSettingsTopic(), (err) => {
        if (err) {
          console.log('error: could not subscribe to settings topic');
        }
      });
    });

    this.client.on('close', () => {
      self.reconnect();
    });

    this.client.on('message', (topic, message) => {
      //const command = message.toString();
      const command = message.toString().substring(0, 1) === '{'
        ? JSON.parse(message.toString())
        : message.toString();

      if (topic === startTopic && message.toString() === "online") {
        logger('home assistant has started. lets do discovery.');
        setTimeout(() => self.emit('connected'), 2000);
      } else if (topic === getSettingsTopic()) {
        self.emit('settingsChanged', command);
      } else if (_.includes(topic, 'set')) {
        const device = self.devices.find(x => getCommandTopic(x) === topic);
        self.emit('stateChanged', device, command);
      }
    });
  }

  updateSettings(settings) {
    if (settings.debug) {
      debug = 'console';
    }
    else {
      debug = '';
    }
  }

  reconnect() {
    this.client.reconnect();
  }

  disconnect(callback) {
    console.log("Disconnecting");
    console.log(this.devices)
    this.devices.forEach((device) => {
      console.log(device);
      console.log(getAvailabilityTopic(device));
      this.client.publish(
        getAvailabilityTopic(device),
        "offline"
      );
    });
    this.client.end(callback);
  }

  discover(devices) {
    this.devices = devices;

    const self = this;
    logger('sending discovery of ' + devices.length + ' device(s).');

    devices.forEach((device) => {
      logger(`sending discovery for ${device.name}`);

      let payload = getDiscoveryPayload(device);
      console.log(`plejd-mqtt: discovered ${device.type} (${device.typeName}) named ${device.name} with PID ${device.id}.`);

      self.deviceMap[device.id] = payload.unique_id;

      self.client.publish(
        getConfigPath(device),
        JSON.stringify(payload)
      );
      setTimeout(() => self.client.publish(getAvailabilityTopic(device), 'online'), 2000);
    });
  }

  updateState(deviceId, data, deviceInitiated) {
    const device = this.devices.find(x => x.id === deviceId);

    if (!device) {
      logger('error: ' + deviceId + ' is not handled by us.');
      return;
    }

    const state = data.state == 1 ? 'ON' : 'OFF';
    let payload = null;
    if (device.type === 'switch') {
      payload = state;
    } else if (device.dimmable) {
      payload = JSON.stringify({ state, brightness: data.brightness });
    } else {
      payload = JSON.stringify({ state });
    }

    logger(`Device ${deviceId} (${device.room?.title} ${device.name}) updateState: ${payload}`);
    this.client.publish(getStateTopic(device), payload);

    if (deviceInitiated) {
      this.client.publish(getAvailabilityTopic(device), 'online');
    }
  }

  sceneTriggered(scene) {
    this.client.publish(getSceneEventTopic(), JSON.stringify({ scene }));
  }
}

module.exports = { MqttClient };

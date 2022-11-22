const axios = require('axios');
const EventEmitter = require('events');
const _ = require('lodash');
const fs = require('fs')

API_APP_ID = 'zHtVqXt8k4yFyk2QGmgp48D9xZr2G94xWYnF4dak';
API_BASE_URL = 'https://cloud.plejd.com/parse/';
API_LOGIN_URL = 'login';
API_SITE_LIST_URL = 'functions/getSiteList';
API_SITE_DETAILS_URL = 'functions/getSiteById';

// #region logging
let debug = 'console';

const getLogger = () => {
  const consoleLogger = msg => console.log('plejd-api', msg);
  if (debug === 'console') {
    return consoleLogger;
  }
  return _.noop;
};

const logger = getLogger();
// #endregion

class PlejdApi extends EventEmitter {
  constructor(siteName, username, password, includeRoomsAsLights) {
    super();

    this.includeRoomsAsLights = includeRoomsAsLights;
    this.siteName = siteName;
    this.username = username;
    this.password = password;

    this.sessionToken = '';
    this.site = null;
  }

  updateSettings(settings) {
    if (settings.debug) {
      debug = 'console';
    }
    else {
      debug = '';
    }
  }

  login() {
    console.log('plejd-api: login()');
    console.log('plejd-api: logging into ' + this.siteName);
    const self = this;

    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'Content-Type': 'application/json'
      }
    });

    return new Promise((resolve, reject) => {
      logger('sending POST to ' + API_BASE_URL + API_LOGIN_URL);

      instance.post(
        API_LOGIN_URL,
        {
          'username': this.username,
          'password': this.password
        })
        .then((response) => {
          console.log('plejd-api: got session token response');
          self.sessionToken = response.data.sessionToken;

          if (!self.sessionToken) {
            console.log('plejd-api: error: no session token received');
            reject('no session token received.');
          }

          resolve();
        })
        .catch((error) => {
          if (error.response.status === 400) {
            console.log('error: server returned status 400. probably invalid credentials, please verify.');
          }
          else {
            console.log('error: unable to retrieve session token response: ' + error);
          }

          reject('unable to retrieve session token response: ' + error);
        });
    });
  }

  getSites() {
    console.log('plejd-api: getSites()');
    const self = this;

    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'X-Parse-Session-Token': this.sessionToken,
        'Content-Type': 'application/json'
      }
    });

    return new Promise((resolve, reject) => {
      logger('sending POST to ' + API_BASE_URL + API_SITE_LIST_URL);

      instance.post(API_SITE_LIST_URL)
        .then((response) => {
          console.log('plejd-api: got site list response');
          const site = response.data.result.find(x => x.site.title == self.siteName);

          if (!site) {
            console.log('plejd-api: error: failed to find a site named ' + self.siteName);
            reject('failed to find a site named ' + self.siteName);
            return;
          }

          resolve(site);
        })
        .catch((error) => {
          console.log('plejd-api: error: unable to retrieve list of sites. error: ' + error);
          return reject('plejd-api: unable to retrieve list of sites. error: ' + error);
        });
    });
  }

  getSite(siteId) {
    console.log('plejd-api: getSite(...)');
    const self = this;

    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'X-Parse-Session-Token': this.sessionToken,
        'Content-Type': 'application/json'
      }
    });

    return new Promise((resolve, reject) => {
      logger('sending POST to ' + API_BASE_URL + API_SITE_DETAILS_URL);

      instance.post(API_SITE_DETAILS_URL, { siteId: siteId })
        .then((response) => {
          console.log('plejd-api: got site details response');
          if (response.data.result.length === 0) {
            const msg = 'no site with ID ' + siteId + ' was found.';
            console.log('plejd-api: error: ' + msg);
            reject(msg);
            return;
          }

          self.site = response.data.result[0];
          self.cryptoKey = self.site.plejdMesh.cryptoKey;

          resolve(self.cryptoKey);
        })
        .catch((error) => {
          console.log('plejd-api: error: unable to retrieve the crypto key. error: ' + error);
          return reject('plejd-api: unable to retrieve the crypto key. error: ' + error);
        });
    });
  }

  getDevices() {
    let devices = [];

    // Just log the devices if debug logging enabled
    if (debug) {
      fs.writeFileSync('/plejd/site.json', JSON.stringify(this.site))
    }

    const roomDevices = {};

    for (let i = 0; i < this.site.devices.length; i++) {
      const device = this.site.devices[i];
      const deviceId = device.deviceId;

      const outputSettings = this.site.outputSettings.find(x => x.deviceParseId == device.objectId);
      const deviceNum = outputSettings ? this.site.outputAddress[deviceId][outputSettings.output] : this.site.deviceAddress[deviceId];

      // check if device is dimmable
      const plejdDevice = this.site.plejdDevices.find(x => x.deviceId == deviceId);

      devices.push({
        id: deviceNum,
        name: device.title,
        type: device.outputType == 'LIGHT' ? 'light' : (device.outputType == 'RELAY' ? 'switch' : 'switch'),
        typeName: plejdDevice.firmware.notes,
        outputIndex: outputSettings?.output || 0,
        dimmable: device.outputType == 'LIGHT' && outputSettings && outputSettings.dimCurve != 'NonDimmable' && outputSettings.dimCurve != 'RelayNormal',
        version: plejdDevice.firmware.version,
        serialNumber: plejdDevice.deviceId,
        room: this.site.rooms.find(x => x.roomId == device.roomId),
      });
    }

    // add scenes as switches
    const scenes = this.site.scenes.filter(x => x.hiddenFromSceneList == false);

    for (const scene of scenes) {
      devices.push({
        id: this.site.sceneIndex[scene.sceneId],
        name: scene.title,
        type: 'scene',
        typeName: 'Scene',
      });
    }

    return devices;
  }
}

module.exports = { PlejdApi };

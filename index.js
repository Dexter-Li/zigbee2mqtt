require('core-js/features/object/from-entries');
require('core-js/features/array/flat');
const semver = require('semver');
const engines = require('./package.json').engines;
const indexJsRestart = 'indexjs.restart';
const fs = require('fs');
const path = require('path');
const {exec} = require('child_process');
const rimraf = require('rimraf');
require('source-map-support').install();

let controller;
let stopping = false;

const hashFile = path.join(__dirname, 'dist', '.hash');

async function restart() {
    await stop(indexJsRestart);
    await start();
}

async function exit(code, reason) {
    if (reason !== indexJsRestart) {
        process.exit(code);
    }
}

async function currentHash() {
    const git = require('git-last-commit');
    return new Promise((resolve) => {
        git.getLastCommit((err, commit) => {
            if (err) resolve('unknown');
            else resolve(commit.shortHash);
        });
    });
}

async function writeHash() {
    const hash = await currentHash();
    fs.writeFileSync(hashFile, hash);
}

async function build(reason) {
    return new Promise((resolve, reject) => {
        process.stdout.write(`Building Zigbee2MQTT... (${reason})`);
        rimraf.sync('dist');
        exec('npm run build', {cwd: __dirname}, async (err, stdout, stderr) => {
            if (err) {
                process.stdout.write(', failed\n');
                reject(err);
            } else {
                process.stdout.write(', finished\n');
                resolve();
            }
        });
    });
}

async function checkDist() {
    if (!fs.existsSync(hashFile)) {
        await build('initial build');
    }

    const distHash = fs.readFileSync(hashFile, 'utf-8');
    const hash = await currentHash();
    if (hash !== 'unknown' && distHash !== hash) {
        await build('hash changed');
    }
}

async function start() {
    await checkDist();

    const version = engines.node;
    if (!semver.satisfies(process.version, version)) {
        console.log(`\t\tZigbee2MQTT requires node version ${version}, you are running ${process.version}!\n`); // eslint-disable-line
    }

    // Validate settings
    const settings = require('./dist/util/settings');
    settings.reRead();
    const errors = settings.validate();
    if (errors.length > 0) {
        console.log(`\n\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
        console.log('            READ THIS CAREFULLY\n');
        console.log(`Refusing to start because configuration is not valid, found the following errors:`);
        for (const error of errors) {
            console.log(`- ${error}`);
        }
        console.log(`\nIf you don't know how to solve this, read https://www.zigbee2mqtt.io/information/configuration.html`); // eslint-disable-line
        console.log(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n`);
        exit(1);
    }

    const Controller = require('./dist/controller');
    controller = new Controller(restart, exit);
    // MODIFED_BY_DEXTER_LI_START
    //await controller.start();
    controller.start();
    // MODIFED_BY_DEXTER_LI_END
}

async function stop(reason=null) {
    await controller.stop(reason);
}

async function handleQuit() {
    if (!stopping && controller) {
        stopping = true;
        await stop();
    }
}

if (process.argv.length === 3 && process.argv[2] === 'writehash') {
    writeHash();
} else {
    process.on('SIGINT', handleQuit);
    process.on('SIGTERM', handleQuit);
    start();
    // MODIFED_BY_DEXTER_LI_START
    const express = require('express')
    const settings = require('./dist/util/settings');

    const app = express()
    app.use(express.json())

    app.get('/api/z2m/mqtt/uri', getMqttServerURI)
    app.put('/api/z2m/mqtt/uri', setMqttURI)
    app.put('/api/z2m/mqtt/credential', setMqttCredential)
    app.get('/api/z2m/mqtt/credential/userName', getMqttUserName)
    app.get('/api/z2m/zigbee/devices', getDevices)
    app.delete('/api/z2m/zigbee/devices/:id', deleteDevice)
    app.get('/api/z2m/zigbee/permitJoin', getPermitJoin)
    app.post('/api/z2m/zigbee/permitJoin', changePermitJoin)
    app.get('/api/z2m/zigbee/blocklist', getBlockList)
    app.put('/api/z2m/zigbee/blocklist/:id', addBlockList)
    app.delete('/api/z2m/zigbee/blocklist/:id', overrideBlockList)

    function test(req, res) {
        return res.json({
            error: 'OK'
        })
    }

    function getMqttServerURI(req, res) {
        return res.json({
            error: 'OK',
            uri: settings.get().mqtt.server ? settings.get().mqtt.server : ''
        })
    }

    async function setMqttURI(req, res) {
        await controller.mqtt.disconnect()
        settings.set('mqtt.server', req.body.uri)
        controller.mqtt.connect()
        return res.json({
            error: 'OK'
        })
    }

    async function setMqttCredential(req, res) {
        await controller.mqtt.disconnect()
        settings.set('mqtt.user', req.body.userName)
        settings.set('mqtt.password', req.body.password)
        controller.mqtt.connect()
        return res.json({
            error: 'OK'
        })
    }

    function getMqttUserName(req, res) {
        return res.json({
            error: 'OK',
            userName: settings.get().mqtt.user ? settings.get().mqtt.user : ''
        })
    }

    function getDevices(req, res) {
        return res.json({
            error: 'OK',
            devices: controller.zigbee.devices(false)
        })
    }

    async function deleteDevice(req, res) {
        try {
            if (controller.mqtt.isConnected()) {
                await controller.extentions[0].deviceRemove({id: req.params.id})
            } else {
                const device = this.zigbee.resolveEntity(req.params.id);
                if (!device || device.constructor.name.toLowerCase() !== 'device') {
                    throw new Error(`Device '${req.params.id}' does not exist`);
                }
                await device.zh.removeFromNetwork()
                settings.removeDevice(device.ID)
                controller.state.remove(device.ID)
                const id = device.ID
                const name = device.name
                controller.eventBus.emitDeviceRemoved({id, name});
            }
        } catch(e) {
            res.setStatus(404)
            return res.json({
                error: 'OK',
                message: `Device '${req.params.id}' does not exist`
            })
        }
        
        return res.json({
            error: 'OK',
        })
    }

    async function getPermitJoin(req, res) {
        return res.json({
            error: 'OK',
            permitJoin: controller.zigbee.getPermitJoin()
        })
    }

    async function changePermitJoin(req, res) {
        await controller.zigbee.permitJoin(req.body.permitJoin)
        return res.json({
            error: 'OK',
            permitJoin: controller.zigbee.getPermitJoin()
        })
    }

    function getBlockList(req, res) {
        return res.json({
            error: 'OK',
            blocklist: settings.get().blocklist ? settings.get().blocklist : []
        })
    }

    async function addBlockList(req, res) {
        settings.blockDevice(req.params.id)
        try {
            if (controller.mqtt.isConnected()) {
                await controller.extentions[0].deviceRemove({id: req.params.id})
            } else {
                const device = this.zigbee.resolveEntity(req.params.id);
                if (!device || device.constructor.name.toLowerCase() !== 'device') {
                    throw new Error(`Device '${req.params.id}' does not exist`);
                }
                await device.zh.removeFromNetwork()
                settings.removeDevice(device.ID)
                controller.state.remove(device.ID)
                const id = device.ID
                const name = device.name
                controller.eventBus.emitDeviceRemoved({id, name});
            }
        } catch(e) {
        }
        
        return res.json({
            error: 'OK',
        })
    }

    function overrideBlockList(req, res) {
        settings.set('blocklist', req.body.blocklist)
        return res.json({
            error: 'OK'
        })
    }

    app.listen(9601, '127.0.0.1');
    // MODIFED_BY_DEXTER_LI_END
}

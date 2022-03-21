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
let logger
let stopping = false;
let restarting = false;

const hashFile = path.join(__dirname, 'dist', '.hash');

async function restart(updateConfig = () => {}) {
    restarting = true;
    await stop(indexJsRestart);
    updateConfig();
    await start();
    restarting = false;
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
    //await checkDist();

    logger = require('./dist/util/logger').default
    const version = engines.node;
    if (!semver.satisfies(process.version, version)) {
        logger.error(`\t\tZigbee2MQTT requires node version ${version}, you are running ${process.version}!\n`); // eslint-disable-line
    }

    // Validate settings
    const settings = require('./dist/util/settings');
    settings.reRead();
    const errors = settings.validate();
    if (errors.length > 0) {
        logger.error(`\n\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
        logger.error('            READ THIS CAREFULLY\n');
        logger.error(`Refusing to start because configuration is not valid, found the following errors:`);
        for (const error of errors) {
            logger.error(`- ${error}`);
        }
        logger.error(`\nIf you don't know how to solve this, read https://www.zigbee2mqtt.io/information/configuration.html`); // eslint-disable-line
        logger.error(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n`);
        exit(1);
    }

    const Controller = require('./dist/controller');
    controller = new Controller(restart, exit);
    controller.start();
}

async function stop(reason=null) {
    await controller?.stop(reason);
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
    process.on('uncaughtException', function(err) {
        logger?.error('Caught exception: ' + err);
    });
    start();

    const express = require('express')
    const settings = require('./dist/util/settings');

    const app = express()
    app.use(express.json())
    app.use((req, res, next) => {
        if (restarting || stopping) {
            return res.status(503).json({
                error: "Z2M service is stopping/restarting."
            })
        } else {
            next()
        }
    })

    app.get('/api/z2m/mqtt/status', getMQttServerStatus)
    app.get('/api/z2m/mqtt/uri', getMqttServerURI)
    app.put('/api/z2m/mqtt/uri', setMqttURI)
    app.put('/api/z2m/mqtt/credential', setMqttCredential)
    app.get('/api/z2m/mqtt/credential/userName', getMqttUserName)
    app.put('/api/z2m/mqtt/baseTopic', setMqttBaseTopic)
    app.get('/api/z2m/zigbee/devices', getDevices)
    app.delete('/api/z2m/zigbee/devices/:id', deleteDevice)
    app.get('/api/z2m/zigbee/permitJoin', getPermitJoin)
    app.post('/api/z2m/zigbee/permitJoin', changePermitJoin)
    app.get('/api/z2m/zigbee/blocklist', getBlockList)
    app.put('/api/z2m/zigbee/blocklist/:id', addBlockList)
    app.delete('/api/z2m/zigbee/blocklist/:id', removeBlockList)
    app.post('/api/z2m/zigbee/devices/:id/alias', setDeviceAlias)
    app.post('/api/z2m/log/loglevel', setLoglevel)
    app.get('/api/z2m/log/loglevel', getLoglevel)
    app.get('/api/z2m/log/logfile', getLogfile)

    async function _connectMqttBroker() {
        try {
            if (controller !== undefined && !controller.mqtt.isConnected()) {
                await controller.mqtt.connect()
            }
        } catch (e) {
            logger?.error(`MQTT failed to connect: ${e.message}`)
        }
    }

    async function _disconnectMqttBroker() {
        try {
            await controller.mqtt.disconnect()
        } catch (e) {
            logger?.error(`MQTT failed to disconnect: ${e.message}`)
        }
    }

    function getMQttServerStatus(req, res) {
        return res.json({
            error: 'OK',
            connected: !!controller?.mqtt.isConnected()
        })
    }

    function getMqttServerURI(req, res) {
        const server = settings.get().mqtt.server
        return res.json({
            error: 'OK',
            uri: server !== undefined ? server : ''
        })
    }

    async function setMqttURI(req, res, next) {
        try {
            await _disconnectMqttBroker()
            settings.set(['mqtt', 'server'], req.body.uri)
            _connectMqttBroker()
        } catch (e) {
            return next(e)
        }
        return res.json({
            error: 'OK'
        })
    }

    async function setMqttCredential(req, res, next) {
        try {
            await _disconnectMqttBroker()
            settings.set(['mqtt', 'user'], req.body.userName)
            settings.set(['mqtt', 'password'], req.body.password)
            _connectMqttBroker()
        } catch (e) {
            return next(e)
        }
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

    async function setMqttBaseTopic(req, res, next) {
        if (!req.body.baseTopic) {
            return res.status(400).end()
        }
        if (req.body.baseTopic !== settings.get().mqtt.base_topic) {
            logger?.info(`Change mqtt topic from ${settings.get().mqtt.base_topic} to ${req.body.baseTopic} will restart z2m process.`)
            try {
                settings.set(['mqtt', 'base_topic'], req.body.baseTopic)
                await handleQuit()
            } catch (e) {
                return next(e)
            }
            process.exit()
        }
        return res.json({
            error: 'OK',
            baseTopic: settings.get().mqtt.base_topic
        })
    }

    function getDevices(req, res) {
        const devices = controller?.zigbee.devices(false)
        const devicesCfg = settings.get().devices
        const devicesInfo = devices ? devices.map((dev) => {
            const alias = devicesCfg[dev.zh._ieeeAddr]?.alias
            return {...(dev.zh), alias: alias !== undefined ? alias : ''}
        }) : []
        return res.json({
            error: 'OK',
            devices: devicesInfo
        })
    }

    async function deleteDevice(req, res, next) {
        try {
            if (controller?.mqtt.isConnected()) {
                await controller.extensions[0].deviceRemove({id: req.params.id})
            } else {
                const device = controller?.zigbee.resolveEntity(req.params.id);
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
            if (e.message.endsWith('does not exist')){
                res.status(404)
                return res.json({
                    error: e.message
                })
            } else {
                return next(e)
            }
        }
        
        return res.json({
            error: 'OK',
        })
    }

    function getPermitJoin(req, res) {
        return res.json({
            error: 'OK',
            permitJoin: !!controller?.zigbee.getPermitJoin()
        })
    }

    async function changePermitJoin(req, res, next) {
        try {
            await controller?.zigbee.permitJoin(req.body.permitJoin, undefined, 1800)
        } catch (e) {
            return next(e)
        }
        return res.json({
            error: 'OK',
            permitJoin: !!controller?.zigbee.getPermitJoin()
        })
    }

    function getBlockList(req, res) {
        return res.json({
            error: 'OK',
            blocklist: settings.get().blocklist ? settings.get().blocklist : []
        })
    }

    async function addBlockList(req, res, next) {
        settings.blockDevice(req.params.id)
        try {
            const device = controller?.zigbee.resolveEntity(req.params.id)
            try {
                if (device && device.constructor.name.toLowerCase() === 'device') {
                    if (controller.mqtt.isConnected()) {
                        await controller.extensions[0].deviceRemove({id: req.params.id})
                    } else {
                        await device.zh.removeFromNetwork()
                        settings.removeDevice(device.ID)
                        controller.state.remove(device.ID)
                        const id = device.ID
                        const name = device.name
                        controller.eventBus.emitDeviceRemoved({id, name});
                    }
                }
            } catch (e) {
                return next(e)
            }
        } catch (e) {
        }
        
        return res.json({
            error: 'OK',
        })
    }

    function removeBlockList(req, res) {
        if (settings.get().blocklist !== undefined) {
            var blockList = settings.get().blocklist
            while (true) {
                const index = blockList.indexOf(req.params.id)
                if (index !== -1) {
                    blockList.splice(index, 1)
                } else {
                    break
                }
            }
            settings.set(['blocklist'], blockList)
        }
        return res.json({
            error: 'OK'
        })
    }

    async function setDeviceAlias(req, res) {
        if (settings.get().devices[req.params.id] !== undefined) {
            settings.set(['devices', req.params.id, 'alias'], req.body.alias)
            if (controller.mqtt.isConnected()) {
                try {
                    await controller.extensions[0].publishDevices()
                } catch (e) {
                }
            }
            return res.json({
                error: 'OK'
            })
        } else {
            res.status(404)
            return res.json({
                error: 'Device not exist.'
            })
        }
    }

    function setLoglevel(req, res) {
        if (['debug', 'info', 'warn', 'error'].includes(req.body.loglevel)) {
            settings.set(['advanced', 'log_level'], req.body.loglevel)
            logger.setLevel(req.body.loglevel)
            return res.json({
                error: 'OK'
            })
        } else {
            res.status(400)
            return res.json({
                error: 'Invalid loglevel string.'
            })
        }
    }

    function getLoglevel(req, res) {
        const loglevel = settings.get()?.advanced?.log_level
        return res.json({
            error: 'OK',
            loglevel: loglevel ? loglevel : 'info'
        })
    }

    async function getLogfile(req, res) {
        var Archiver = require('archiver');

        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-disposition': `attachment; filename=z2mlog_${Date.now()}.zip`
        });
        var zip = Archiver('zip');
        zip.pipe(res);
        zip.directory('./data/log/', false).finalize();
    }

    app.use(function (err, req, res, next) {
        console.error(err.stack)
        res.status(500).json({
            error: err.message
        })
      })

    app.listen(9601, process.env.Z2M_IN_CONTAINER ? '0.0.0.0' : '127.0.0.1');
}

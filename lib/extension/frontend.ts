import http from 'http';
import serveStatic from 'serve-static';
import finalhandler from 'finalhandler';
import logger from '../util/logger';
import frontend from 'zigbee2mqtt-frontend';
import WebSocket from 'ws';
import net from 'net';
import url from 'url';
import * as settings from '../util/settings';
import utils from '../util/utils';
import stringify from 'json-stable-stringify-without-jsonify';
import Extension from './extension';
import bind from 'bind-decorator';

/**
 * This extension servers the frontend
 */
export default class Frontend extends Extension {
    private mqttBaseTopic = settings.get().mqtt.base_topic;
    private host = process.env.Z2M_IN_CONTAINER ? '0.0.0.0' : '127.0.0.1';
    private port = 9602;
    private retainedMessages = new Map();
    private wss: WebSocket.Server = null;

    constructor(zigbee: Zigbee, mqtt: MQTT, state: State, publishEntityState: PublishEntityState,
        eventBus: EventBus, enableDisableExtension: (enable: boolean, name: string) => Promise<void>,
        restartCallback: () => void, addExtension: (extension: Extension) => void) {
        super(zigbee, mqtt, state, publishEntityState, eventBus, enableDisableExtension, restartCallback, addExtension);
        this.eventBus.onMQTTMessagePublished(this, this.onMQTTPublishMessage);
    }

    override async start(): Promise<void> {
        this.wss = new WebSocket.Server({host: this.host, port: this.port});
        this.wss.on('connection', this.onWebSocketConnection);
        logger.info(`Started ws on port ${this.host}:${this.port}`);
    }

    override async stop(): Promise<void> {
        super.stop();
        if (this.wss !== null) {
            for (const client of this.wss.clients) {
                client.send(stringify({topic: 'bridge/state', payload: 'offline'}));
                client.terminate();
            }
            return new Promise((cb: () => void) => this.wss.close(cb));
        }
    }

    @bind private onWebSocketConnection(ws: WebSocket): void {
        ws.on('message', (data: Buffer, isBinary: boolean) => {
            if (!isBinary && data) {
                const message = data.toString();
                const {topic, payload} = JSON.parse(message);
                this.mqtt.onMessage(`${this.mqttBaseTopic}/${topic}`, stringify(payload));
            }
        });

        for (const [key, value] of this.retainedMessages) {
            ws.send(stringify({topic: key, payload: value}));
        }

        for (const device of this.zigbee.devices(false)) {
            let payload: KeyValue = {};
            if (this.state.exists(device)) {
                payload = {...payload, ...this.state.get(device)};
            }

            const lastSeen = settings.get().advanced.last_seen;
            /* istanbul ignore if */
            if (lastSeen !== 'disable') {
                payload.last_seen = utils.formatDate(device.zh.lastSeen, lastSeen);
            }

            if (device.zh.linkquality !== undefined) {
                payload.linkquality = device.zh.linkquality;
            }

            ws.send(stringify({topic: device.name, payload}));
        }
    }

    @bind private onMQTTPublishMessage(data: eventdata.MQTTMessagePublished): void {
        if (data.topic.startsWith(`${this.mqttBaseTopic}/`)) {
            // Send topic without base_topic
            const topic = data.topic.substring(this.mqttBaseTopic.length + 1);
            const payload = utils.parseJSON(data.payload, data.payload);
            if (data.options.retain) {
                this.retainedMessages.set(topic, payload);
            }

            if (this.wss) {
                for (const client of this.wss.clients) {
                    /* istanbul ignore else */
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(stringify({topic, payload}));
                    }
                }
            }
        }
    }
}

// discovery.js — UDP "I'm here" broadcast so bot clients can detect
// map_server startup without polling. Split out of map_server.js.
import dgram from "node:dgram";

export const CONTROL_DISCOVERY_PORT = 41235;

let controlDiscoverySocket = null;
let controlDiscoveryInterval = null;

/** @param {number} port  HTTP port advertised in the hello payload */
export function startControlDiscovery(port) {
    try {
        controlDiscoverySocket = dgram.createSocket("udp4");
        controlDiscoverySocket.on("error", (e) => {
            console.log(`\x1b[33m[MapServer] Control discovery socket error: ${e.message}\x1b[0m`);
        });
        controlDiscoverySocket.bind(0, "127.0.0.1", () => {
            const msg = Buffer.from(
                JSON.stringify({
                    type: "zorr-control-hello",
                    url: `http://localhost:${port}`,
                    pid: process.pid,
                    ts: Date.now(),
                })
            );
            const send = () => {
                if (!controlDiscoverySocket) return;
                try {
                    controlDiscoverySocket.send(msg, CONTROL_DISCOVERY_PORT, "127.0.0.1");
                } catch (e) {
                    /* ignore send errors */
                }
            };
            send();
            controlDiscoveryInterval = setInterval(send, 3000);
            controlDiscoveryInterval.unref();
            console.log(
                `\x1b[36m[MapServer] Broadcasting control discovery on UDP 127.0.0.1:${CONTROL_DISCOVERY_PORT} (every 3s)\x1b[0m`
            );
        });
    } catch (e) {
        console.log(`\x1b[33m[MapServer] Failed to start control discovery: ${e.message}\x1b[0m`);
    }
}

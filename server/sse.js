const { EventEmitter } = require('events');

const HEARTBEAT_MS = 30_000;

// Small pub/sub so multiple browser tabs can share one live feed (events, alerts)
// per host, independent of the existing 1:1 per-container log-stream SSE.
class Broadcaster {
  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
  }

  publish(hostId, payload) {
    this.emitter.emit(hostId, payload);
  }

  subscribe(res, hostId) {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const onPayload = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    this.emitter.on(hostId, onPayload);

    // Behind nginx or any proxy with an idle timeout, a quiet stream gets cut -
    // a periodic comment line keeps the connection alive without affecting listeners.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

    return () => {
      clearInterval(heartbeat);
      this.emitter.off(hostId, onPayload);
    };
  }
}

module.exports = { Broadcaster };

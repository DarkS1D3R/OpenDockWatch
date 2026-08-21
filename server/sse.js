const { EventEmitter } = require('events');

const HEARTBEAT_MS = 30_000;

// Small pub/sub so multiple browser tabs share one live feed (events, alerts) per host,
// independent of the per-container log-stream SSE. Host ids are user-chosen and EventEmitter
// reserves names like 'error' (emitting with no listener throws) - prefixing avoids collisions.
function channel(hostId) {
  return `host:${hostId}`;
}

class Broadcaster {
  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
  }

  // Serialized once per publish rather than inside onPayload (once per subscriber): a host with
  // several open tabs was re-stringifying the same object once per listener on every event/alert.
  publish(hostId, payload) {
    this.emitter.emit(channel(hostId), `data: ${JSON.stringify(payload)}\n\n`);
  }

  // One listener per subscribed response, so the listener count *is* the number of held event
  // streams. Sampled by index.js's periodic vitals line: the open/close pair either side of a
  // stream tells you about one stream, and answering "how many are held right now" from those
  // alone means replaying the whole log - which is not something you can do while the UI is hung.
  subscriberCount() {
    return this.emitter.eventNames().reduce((n, name) => n + this.emitter.listenerCount(name), 0);
  }

  subscribe(res, hostId) {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const onMessage = (frame) => {
      res.write(frame);
    };
    this.emitter.on(channel(hostId), onMessage);

    // Behind nginx or any proxy with an idle timeout, a quiet stream gets cut -
    // a periodic comment line keeps the connection alive without affecting listeners.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

    return () => {
      clearInterval(heartbeat);
      this.emitter.off(channel(hostId), onMessage);
    };
  }
}

module.exports = { Broadcaster };

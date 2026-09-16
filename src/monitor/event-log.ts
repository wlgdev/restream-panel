import type { StreamEvent, StreamEventType } from "../core/types";

export type { StreamEvent, StreamEventType };

export class StreamEventLog {
  private static readonly MAX_EVENTS = 1000;
  private readonly buffer: StreamEvent[] = [];
  private seq = 0;

  public push(event: Omit<StreamEvent, "seq">): StreamEvent {
    this.seq += 1;
    const newEvent: StreamEvent = { ...event, seq: this.seq };
    this.buffer.push(newEvent);

    if (this.buffer.length > StreamEventLog.MAX_EVENTS) {
      this.buffer.shift();
    }

    return newEvent;
  }

  public getSince(since?: number): StreamEvent[] {
    if (since === undefined) {
      return [...this.buffer];
    }
    return this.buffer.filter((event) => event.seq > since);
  }
}

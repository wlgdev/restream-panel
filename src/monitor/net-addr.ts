export const RTMP_MONITOR_INBOUND_PORTS = [1935, 1936] as const;

export function extractIp(address: string | null): string | null {
  if (!address) {
    return null;
  }

  if (address.startsWith("[")) {
    return address.slice(1, address.lastIndexOf("]")) || null;
  }

  const lastColon = address.lastIndexOf(":");
  if (lastColon <= 0) {
    return address;
  }

  return address.slice(0, lastColon);
}

export function normalizeAddr(address: string): string {
  // Strip IPv6 brackets ([::1]:port -> ::1:port) so an address compares the same
  // whether it came from ss (always bracketed for IPv6) or from mediamtx metrics.
  // IPv4 addresses have no leading bracket and are returned unchanged.
  if (!address.startsWith("[")) return address;
  const close = address.indexOf("]");
  if (close < 0) return address;
  return address.slice(1, close) + address.slice(close + 1);
}

export function canonicalAddr(address: string): string {
  // "[::ffff:1.2.3.4]:5678" -> "1.2.3.4:5678": strip the IPv6 brackets, then drop the
  // ::ffff: IPv4-mapped prefix so the form matches mediamtx's rtmp_conns remoteAddr.
  let rest = address;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close >= 0) {
      rest = rest.slice(1, close) + rest.slice(close + 1);
    }
  }
  if (rest.startsWith("::ffff:")) {
    rest = rest.slice("::ffff:".length);
  }
  return rest;
}

export function isLoopbackAddress(address: string): boolean {
  const ip = extractIp(address);
  if (!ip) {
    return false;
  }

  // ss emits IPv4-mapped IPv6 addresses bracketed (e.g. "[::ffff:127.0.0.1]:32854").
  // Strip the ::ffff: prefix so the underlying IPv4 loopback check applies — otherwise
  // loopback<->loopback sockets mediamtx opens to itself would slip past the filter
  // and surface in the dashboard as a bogus RTMP stream.
  const normalized = ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;

  return normalized === "::1" || normalized.startsWith("127.");
}

export function isLoopbackRemote(address: string): boolean {
  // ip:port with an optional bracketed IPv6 host ([::1]:5000).
  const host = address.startsWith("[") ? address.slice(1, address.lastIndexOf("]")) : address.slice(0, address.lastIndexOf(":"));

  return host === "::1" || host === "::ffff:127.0.0.1" || host.startsWith("127.");
}

export function isMonitoredInboundAddress(address: string | null): boolean {
  if (!address) {
    return false;
  }

  return RTMP_MONITOR_INBOUND_PORTS.some((port) => address.endsWith(`:${port}`));
}

import type { Socket } from "socket.io";

/**
 * Socket.io's handshake address doesn't automatically respect Express's
 * "trust proxy" setting the way `req.ip` does — behind Traefik, the real
 * client IP is in X-Forwarded-For. Resolve it the same way for every
 * IP-dependent decision (moderation bans, ban-check middleware).
 */
export function getSocketIp(socket: Socket): string {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (forwardedValue) {
    const first = forwardedValue.split(",")[0]?.trim();
    if (first) return first;
  }
  return socket.handshake.address;
}

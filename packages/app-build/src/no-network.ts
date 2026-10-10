import dgram from "node:dgram";
import net from "node:net";

/**
 * Makes this process unable to open a socket: every connect of a TCP or local socket and every
 * new datagram socket throws. A build opens none, so this changes nothing for it; a library
 * that started to would fail here instead of reaching a host. It is a check inside the process,
 * not an operating system boundary. Returns the call that puts the functions back.
 */
export function refuseNetwork(): () => void {
  const connect = net.Socket.prototype.connect;
  const createSocket = dgram.createSocket;
  const refuse = (): never => {
    throw new Error("A Page build opens no network connection");
  };
  net.Socket.prototype.connect = refuse;
  dgram.createSocket = refuse;
  return () => {
    net.Socket.prototype.connect = connect;
    dgram.createSocket = createSocket;
  };
}

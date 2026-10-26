import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

const denied = () => { throw new Error("Network access outside the artifact's mocked Slack responses"); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  let options: unknown = args[0];
  if (Array.isArray(options)) options = options[0];
  if ((typeof options === "string" && options.startsWith("/")) ||
      (options && typeof options === "object" && "path" in options && typeof options.path === "string")) {
    return Reflect.apply(connect, this, args);
  }
  return denied();
};
globalThis.fetch = denied;
tls.connect = denied;
dgram.Socket.prototype.send = denied;
for (const surface of [dns, dns.promises]) {
  for (const name of Object.keys(surface)) {
    if (name === "lookup" || name === "lookupService" || name.startsWith("resolve") || name === "reverse") {
      Reflect.set(surface, name, denied);
    }
  }
}
syncBuiltinESMExports();

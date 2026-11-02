/**
 * Utility for patching AmneziaWG client configuration files.
 *
 * Rules:
 * - AllowedIPs is strictly replaced with "0.0.0.0/0" (IPv6 route "::/0" is completely removed).
 * - PersistentKeepalive is forcefully set to "15".
 */
export function patchConfig(rawConfig: string): string {
  let config = rawConfig;

  // 1. Patch AllowedIPs: replace existing directive or inject under [Peer]
  if (/^[ \t]*AllowedIPs[ \t]*=/im.test(config)) {
    config = config.replace(/^[ \t]*AllowedIPs[ \t]*=.*$/gim, "AllowedIPs = 0.0.0.0/0");
  } else if (/\[Peer\]/i.test(config)) {
    config = config.replace(/(\[Peer\][^\r\n]*)/i, "$1\nAllowedIPs = 0.0.0.0/0");
  } else {
    config += "\nAllowedIPs = 0.0.0.0/0\n";
  }

  // 2. Patch PersistentKeepalive: replace existing directive or inject under [Peer]
  if (/^[ \t]*PersistentKeepalive[ \t]*=/im.test(config)) {
    config = config.replace(/^[ \t]*PersistentKeepalive[ \t]*=.*$/gim, "PersistentKeepalive = 15");
  } else if (/\[Peer\]/i.test(config)) {
    config = config.replace(/(\[Peer\][^\r\n]*)/i, "$1\nPersistentKeepalive = 15");
  } else {
    config += "\nPersistentKeepalive = 15\n";
  }

  return config;
}

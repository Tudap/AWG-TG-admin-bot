import { $ } from "bun";
import { patchConfig } from "./patcher";

const SCRIPT = process.env.AWG_SCRIPT || "/usr/local/bin/manage_amneziawg.sh";

export interface AwgClient {
  name: string;
  ip?: string;
  status?: string;
  created_at?: string;
  expires_at?: string;
  enabled?: boolean;
  [key: string]: any;
}

export interface AwgConfigResult {
  client: string;
  configPath: string;
  config: string;
  raw: any;
}

export interface AwgStatsPeer {
  name?: string;
  public_key?: string;
  endpoint?: string;
  allowed_ips?: string;
  latest_handshake?: number | string;
  transfer_rx?: number | string;
  transfer_tx?: number | string;
  [key: string]: any;
}

export interface AwgStatsResult {
  interface?: string;
  public_key?: string;
  listening_port?: number;
  peers?: AwgStatsPeer[];
  raw?: any;
}

export interface AwgBackupResult {
  backupPath: string;
  raw: any;
}

/**
 * Resolves the absolute path to a client's .conf file on disk.
 */
async function resolveConfigPath(name: string, res?: any): Promise<string> {
  const fromRes =
    res?.config_path ||
    res?.path ||
    res?.file ||
    res?.config_file ||
    res?.configFile;

  if (typeof fromRes === "string" && fromRes.trim().length > 0) {
    return fromRes.trim();
  }

  // Common locations used by bivlked/amneziawg-installer and standard wg
  const candidates = [
    `/etc/amnezia/amneziawg/clients/${name}.conf`,
    `/root/${name}.conf`,
    `/etc/wireguard/clients/${name}.conf`,
    `/etc/amneziawg/clients/${name}.conf`,
    `/home/${name}.conf`,
    `./${name}.conf`,
  ];

  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
  }

  // Fallback to standard installer path
  return `/etc/amnezia/amneziawg/clients/${name}.conf`;
}

/**
 * Adds a new AmneziaWG client.
 * Calls `manage_amneziawg.sh add <name> [--expires=<expires>] --json`.
 * Reads created config, applies patchConfig, writes back to disk, and returns the result.
 */
export async function add(name: string, expires?: string): Promise<AwgConfigResult> {
  let res: any;
  if (expires) {
    res = await $`${SCRIPT} add ${name} --expires=${expires} --json`.json();
  } else {
    res = await $`${SCRIPT} add ${name} --json`.json();
  }

  const configPath = await resolveConfigPath(name, res);
  let rawConfig = "";

  if (await Bun.file(configPath).exists()) {
    rawConfig = await Bun.file(configPath).text();
  } else if (res?.config || res?.content) {
    rawConfig = String(res.config || res.content);
  } else {
    throw new Error(
      `Конфигурационный файл клиента "${name}" не найден по пути "${configPath}".`
    );
  }

  const patched = patchConfig(rawConfig);
  await Bun.write(configPath, patched);

  return {
    client: name,
    configPath,
    config: patched,
    raw: res,
  };
}

/**
 * Removes an existing AmneziaWG client.
 * Calls `manage_amneziawg.sh remove <name> --json`.
 */
export async function remove(name: string): Promise<any> {
  const res = await $`${SCRIPT} remove ${name} --json`.json();
  return res;
}

/**
 * Regenerates / re-issues configuration for an existing client.
 * Calls `manage_amneziawg.sh regen <name> --json`.
 * Reads config, applies patchConfig, writes back to disk, and returns the result.
 */
export async function regen(name: string): Promise<AwgConfigResult> {
  const res = (await $`${SCRIPT} regen ${name} --json`.json()) as any;
  const configPath = await resolveConfigPath(name, res);
  let rawConfig = "";

  if (await Bun.file(configPath).exists()) {
    rawConfig = await Bun.file(configPath).text();
  } else if (res?.config || res?.content) {
    rawConfig = String(res.config || res.content);
  } else {
    throw new Error(
      `Не удалось прочитать перевыпущенный файл конфигурации для "${name}" по пути "${configPath}".`
    );
  }

  const patched = patchConfig(rawConfig);
  await Bun.write(configPath, patched);

  return {
    client: name,
    configPath,
    config: patched,
    raw: res,
  };
}

/**
 * Retrieves the list of clients from `manage_amneziawg.sh list --json`.
 */
export async function list(): Promise<AwgClient[]> {
  const res = (await $`${SCRIPT} list --json`.json()) as any;
  let rawList: any[] = [];

  if (Array.isArray(res)) {
    rawList = res;
  } else if (res && Array.isArray(res.clients)) {
    rawList = res.clients;
  } else if (res && Array.isArray(res.peers)) {
    rawList = res.peers;
  }

  return rawList.map((item) => ({
    ...item,
    name: item.name || item.client || item.user || "unknown",
    ip: item.ip || item.address || item.client_ip,
    status: item.status || (item.enabled === false ? "disabled" : "active"),
    created_at: item.created_at || item.createdAt || item.created,
    expires_at: item.expires_at || item.expiresAt || item.expires,
  }));
}

/**
 * Retrieves traffic and interface stats from `manage_amneziawg.sh stats --json`.
 */
export async function stats(): Promise<AwgStatsResult> {
  const res = (await $`${SCRIPT} stats --json`.json()) as any;

  if (Array.isArray(res)) {
    return {
      peers: res.map((item) => ({
        ...item,
        name: item.name || item.client || item.user,
      })),
      raw: res,
    };
  }

  return {
    interface: res?.interface || res?.device || "awg0",
    public_key: res?.public_key || res?.publicKey,
    listening_port: res?.listening_port || res?.port,
    peers: (res?.peers || []).map((p: any) => ({
      ...p,
      name: p.name || p.client || p.user,
    })),
    raw: res,
  };
}

/**
 * Checks server health and diagnostic output from `manage_amneziawg.sh check`.
 * Returns plaintext output.
 */
export async function check(): Promise<string> {
  const text = await $`${SCRIPT} check`.text();
  return text;
}

/**
 * Creates a server configuration backup using `manage_amneziawg.sh backup --json`.
 * Returns the path to the created .tar.gz archive.
 */
export async function backup(): Promise<AwgBackupResult> {
  const res = (await $`${SCRIPT} backup --json`.json()) as any;

  const backupPath =
    res?.backup_path ||
    res?.path ||
    res?.file ||
    res?.archive ||
    res?.backupPath ||
    res?.archive_path;

  if (!backupPath || typeof backupPath !== "string") {
    throw new Error(
      `Скрипт бэкапа не вернул путь к архиву: ${JSON.stringify(res)}`
    );
  }

  const trimmedPath = backupPath.trim();
  if (!(await Bun.file(trimmedPath).exists())) {
    throw new Error(`Файл бэкапа не найден на диске: ${trimmedPath}`);
  }

  return {
    backupPath: trimmedPath,
    raw: res,
  };
}

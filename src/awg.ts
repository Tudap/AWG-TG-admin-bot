import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import { patchConfig } from "./patcher";

/**
 * Checks if current process is running as root user (uid === 0).
 */
export function isUserRoot(): boolean {
  return typeof process.getuid === "function" ? process.getuid() === 0 : true;
}

/**
 * Resolves the path to manage_amneziawg.sh script.
 * Prefers AWG_SCRIPT from env if file exists, then checks typical installation locations:
 * - /root/awg/manage_amneziawg.sh (standard location for bivlked/amneziawg-installer)
 * - ~/awg/manage_amneziawg.sh
 * - /usr/local/bin/manage_amneziawg.sh
 * - /opt/awg/manage_amneziawg.sh
 * - ./manage_amneziawg.sh
 */
export function getScriptPath(): string {
  const envPath = process.env.AWG_SCRIPT;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const home = process.env.HOME || "/root";
  const candidates = [
    "/root/awg/manage_amneziawg.sh",
    path.join(home, "awg", "manage_amneziawg.sh"),
    "/usr/local/bin/manage_amneziawg.sh",
    "/opt/awg/manage_amneziawg.sh",
    path.resolve("manage_amneziawg.sh"),
    path.resolve("awg/manage_amneziawg.sh"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      if (envPath && envPath !== candidate) {
        console.warn(
          `[AWG] Заданный AWG_SCRIPT="${envPath}" не найден на диске. Автоматически найден и используется путь: "${candidate}"`
        );
      }
      return candidate;
    }
  }

  // Fallback to envPath if defined, or default standard installer path
  return envPath || "/root/awg/manage_amneziawg.sh";
}

/**
 * Executes manage_amneziawg.sh with given arguments in its working directory.
 * If running as non-root, automatically prepends sudo unless disabled.
 * Detailed stderr/stdout is attached to error messages for debugging.
 */
export async function execAwg(args: string[]): Promise<string> {
  const script = getScriptPath();
  const scriptDir = path.dirname(script);
  const isRoot = isUserRoot();
  const useSudo = !isRoot && process.env.AWG_USE_SUDO !== "false";

  try {
    if (useSudo) {
      return await $`sudo ${script} ${args}`.cwd(scriptDir).text();
    } else {
      return await $`${script} ${args}`.cwd(scriptDir).text();
    }
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.()?.trim();
    const stdout = err?.stdout?.toString?.()?.trim();
    const details = [stderr, stdout].filter(Boolean).join("\n");
    if (details) {
      throw new Error(`${err.message || "Command failed"}:\n${details}`);
    }
    throw err;
  }
}

/**
 * Parses JSON output from the management script, handling any potential
 * bash warnings or banners printed before the JSON payload.
 */
export function parseJsonOutput(stdout: string): any {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];
      if (char === "{" || char === "[") {
        try {
          return JSON.parse(trimmed.slice(i));
        } catch {
          // Continue scanning if this wasn't the start of valid JSON
        }
      }
    }
    throw new Error(`Не удалось распарсить JSON из вывода скрипта: ${trimmed}`);
  }
}

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
 * Prioritizes script directory (e.g. /root/awg/<name>.conf) where bivlked installer places configs.
 */
export async function resolveConfigPath(
  name: string,
  res?: any,
  scriptDir?: string
): Promise<string> {
  const fromRes =
    res?.config_path ||
    res?.path ||
    res?.file ||
    res?.config_file ||
    res?.configFile;

  const baseDir = scriptDir || path.dirname(getScriptPath());
  const home = process.env.HOME || "/root";

  if (typeof fromRes === "string" && fromRes.trim().length > 0) {
    const p = fromRes.trim();
    if (path.isAbsolute(p)) return p;
    return path.resolve(baseDir, p);
  }

  // Common locations used by bivlked/amneziawg-installer and standard wg
  const candidates = [
    path.join(baseDir, `${name}.conf`),
    path.join(baseDir, "clients", `${name}.conf`),
    `/root/awg/${name}.conf`,
    path.join(home, "awg", `${name}.conf`),
    `/etc/amnezia/amneziawg/clients/${name}.conf`,
    path.join(home, `${name}.conf`),
    `/root/${name}.conf`,
    `/etc/wireguard/clients/${name}.conf`,
    `/etc/amneziawg/clients/${name}.conf`,
    path.resolve(`${name}.conf`),
  ];

  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
  }

  // Fallback to script directory
  return path.join(baseDir, `${name}.conf`);
}

/**
 * Adds a new AmneziaWG client.
 * Calls `manage_amneziawg.sh add <name> [--expires=<expires>] --json`.
 * Reads created config, applies patchConfig, writes back to disk, and returns the result.
 */
export async function add(name: string, expires?: string): Promise<AwgConfigResult> {
  const script = getScriptPath();
  const scriptDir = path.dirname(script);

  const args = expires
    ? ["add", name, `--expires=${expires}`, "--json"]
    : ["add", name, "--json"];

  const out = await execAwg(args);
  const res = parseJsonOutput(out);
  const configPath = await resolveConfigPath(name, res, scriptDir);
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
  const out = await execAwg(["remove", name, "--json"]);
  return parseJsonOutput(out);
}

/**
 * Regenerates / re-issues configuration for an existing client,
 * or retrieves and re-patches existing configuration on disk.
 * Calls `manage_amneziawg.sh regen <name> --json`.
 * Reads config, applies patchConfig, writes back to disk, and returns the result.
 */
export async function regen(name: string): Promise<AwgConfigResult> {
  const script = getScriptPath();
  const scriptDir = path.dirname(script);

  let res: any = null;
  try {
    const out = await execAwg(["regen", name, "--json"]);
    res = parseJsonOutput(out);
  } catch (err: any) {
    // If CLI does not support 'regen' or failed, check if the config already exists on disk
    const existingCandidate = await resolveConfigPath(name, null, scriptDir);
    if (!(await Bun.file(existingCandidate).exists())) {
      throw err;
    }
  }

  const configPath = await resolveConfigPath(name, res, scriptDir);
  let rawConfig = "";

  if (await Bun.file(configPath).exists()) {
    rawConfig = await Bun.file(configPath).text();
  } else if (res?.config || res?.content) {
    rawConfig = String(res.config || res.content);
  } else {
    throw new Error(
      `Не удалось прочитать файл конфигурации для "${name}" по пути "${configPath}".`
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
  const out = await execAwg(["list", "--json"]);
  const res = parseJsonOutput(out);
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
  const out = await execAwg(["stats", "--json"]);
  const res = parseJsonOutput(out);

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
  const text = await execAwg(["check"]);
  return text;
}

/**
 * Creates a server configuration backup using `manage_amneziawg.sh backup --json`.
 * Returns the path to the created .tar.gz archive.
 */
export async function backup(): Promise<AwgBackupResult> {
  const script = getScriptPath();
  const scriptDir = path.dirname(script);
  const out = await execAwg(["backup", "--json"]);
  const res = parseJsonOutput(out);

  const rawPath =
    res?.backup_path ||
    res?.path ||
    res?.file ||
    res?.archive ||
    res?.backupPath ||
    res?.archive_path;

  if (!rawPath || typeof rawPath !== "string") {
    throw new Error(
      `Скрипт бэкапа не вернул путь к архиву: ${JSON.stringify(res)}`
    );
  }

  let trimmedPath = rawPath.trim();
  if (!path.isAbsolute(trimmedPath)) {
    trimmedPath = path.resolve(scriptDir, trimmedPath);
  }

  if (!(await Bun.file(trimmedPath).exists())) {
    // Check if archive filename was created in scriptDir
    const filename = path.basename(trimmedPath);
    const candidate = path.join(scriptDir, filename);
    if (await Bun.file(candidate).exists()) {
      trimmedPath = candidate;
    } else {
      throw new Error(`Файл бэкапа не найден на диске: ${trimmedPath}`);
    }
  }

  return {
    backupPath: trimmedPath,
    raw: res,
  };
}

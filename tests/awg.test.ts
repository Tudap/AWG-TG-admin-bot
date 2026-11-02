import { describe, expect, it } from "bun:test";
import {
  getScriptPath,
  parseJsonOutput,
  parseStatsText,
  resolveConfigPath,
  isUserRoot,
} from "../src/awg";
import { patchConfig } from "../src/patcher";
import path from "node:path";
import os from "node:os";

describe("AWG Paths & Helpers", () => {
  it("should check root user status", () => {
    expect(typeof isUserRoot()).toBe("boolean");
  });

  it("should parse standard JSON output", () => {
    const raw = JSON.stringify({ status: "ok", clients: [] });
    const parsed = parseJsonOutput(raw);
    expect(parsed.status).toBe("ok");
    expect(parsed.clients).toEqual([]);
  });

  it("should parse JSON preceded by bash logs or banners", () => {
    const bannerOutput = `[INFO] Starting AmneziaWG CLI\nLoading configuration...\n{"status":"success","count":2}`;
    const parsed = parseJsonOutput(bannerOutput);
    expect(parsed.status).toBe("success");
    expect(parsed.count).toBe(2);
  });

  it("should parse stats table from manage_amneziawg.sh output", () => {
    const tableOutput = `
[2026-11-02 09:30:44] INFO: Проверка зависимостей...
[2026-11-02 09:30:44] INFO: Статистика трафика клиентов:

Имя       | IP       | Получено  | Отправлено | Последний handshake | Статус
---------------------------------------------------------------------------------
my_phone  | 10.9.9.2 | 2.63 GiB  | 22.68 GiB  | 2026-11-02 09:30:03 | Активен
my_laptop | 10.9.9.3 | 3.01 GiB  | 14.61 GiB  | 2026-11-02 09:30:20 | Активен
test_user | 10.9.9.7 | 0 B       | 0 B        | никогда             | Неактивен

[2026-11-02 09:30:44] INFO: Итого: Получено 5.64 GiB, Отправлено 37.29 GiB
`;

    const peers = parseStatsText(tableOutput);
    expect(peers.length).toBe(3);

    expect(peers[0].name).toBe("my_phone");
    expect(peers[0].ip).toBe("10.9.9.2");
    expect(peers[0].transfer_rx).toBe("2.63 GiB");
    expect(peers[0].transfer_tx).toBe("22.68 GiB");
    expect(peers[0].latest_handshake).toBe("2026-11-02 09:30:03");
    expect(peers[0].status).toBe("Активен");

    expect(peers[2].name).toBe("test_user");
    expect(peers[2].transfer_rx).toBe("0 B");
    expect(peers[2].status).toBe("Неактивен");
  });

  it("should resolve default script path to /root/awg/manage_amneziawg.sh", () => {
    const oldEnv = process.env.AWG_SCRIPT;
    try {
      delete process.env.AWG_SCRIPT;
      const scriptPath = getScriptPath();
      expect(scriptPath).toContain("manage_amneziawg.sh");
      expect(scriptPath).toBe("/root/awg/manage_amneziawg.sh");
    } finally {
      process.env.AWG_SCRIPT = oldEnv;
    }
  });

  it("should resolve client config path in scriptDir", async () => {
    const fakeDir = path.join(os.tmpdir(), "awg_test_" + Date.now());
    await Bun.write(path.join(fakeDir, "testclient.conf"), "[Interface]\n");

    const resolved = await resolveConfigPath("testclient", null, fakeDir);
    expect(resolved).toBe(path.join(fakeDir, "testclient.conf"));
  });

  it("should properly patch configuration", () => {
    const sampleConfig = `[Interface]
PrivateKey = fakeKey
Address = 10.8.0.2/24

[Peer]
PublicKey = serverKey
Endpoint = 198.51.100.1:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
`;

    const patched = patchConfig(sampleConfig);
    expect(patched).toContain("AllowedIPs = 0.0.0.0/0");
    expect(patched).not.toContain("::/0");
    expect(patched).toContain("PersistentKeepalive = 15");
    expect(patched).not.toContain("PersistentKeepalive = 25");
  });
});

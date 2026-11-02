import { describe, expect, it } from "bun:test";
import { getScriptPath, parseJsonOutput, resolveConfigPath } from "../src/awg";
import { patchConfig } from "../src/patcher";
import path from "node:path";
import os from "node:os";

describe("AWG Paths & Helpers", () => {
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

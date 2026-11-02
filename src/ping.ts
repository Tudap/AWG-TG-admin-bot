interface GlobalpingCreateResponse {
  id: string;
  probesCount?: number;
  message?: string;
}

interface ProbeLocation {
  city?: string;
  country?: string;
  asn?: number;
  network?: string;
}

interface ProbeStats {
  min?: number | null;
  avg?: number | null;
  max?: number | null;
  total?: number;
  loss?: number | null;
  rcv?: number;
  drop?: number;
}

interface ProbeResultItem {
  probe: ProbeLocation;
  result: {
    status: "finished" | "in-progress" | "failed";
    rawOutput?: string;
    stats?: ProbeStats;
  };
}

interface GlobalpingMeasurementResponse {
  id: string;
  type: string;
  status: "in-progress" | "finished";
  probesCount?: number;
  results?: ProbeResultItem[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Checks server reachability from Russian probes using Globalping API.
 * Performs a 3-probe ping test from RU, waits for completion, and returns a formatted report.
 */
export async function checkRussianReachability(targetHost: string): Promise<string> {
  const host = targetHost?.trim();

  if (!host || host === "127.0.0.1" || host === "localhost" || host === "0.0.0.0") {
    return (
      "⚠️ *Тест доступности из РФ:*\n" +
      "Не задан или указан некорректный `SERVER_HOST` в файле `.env`.\n" +
      "Пожалуйста, укажите публичный IPv4 или домен вашего сервера."
    );
  }

  try {
    // 1. Create measurement request
    const createRes = await fetch("https://api.globalping.io/v1/measurements", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AmneziaWG-Admin-Bot/1.0",
      },
      body: JSON.stringify({
        type: "ping",
        target: host,
        locations: [{ country: "RU" }],
        limit: 3,
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      return `❌ Ошибка создания замера Globalping (HTTP ${createRes.status}): ${errText || createRes.statusText}`;
    }

    const created = (await createRes.json()) as GlobalpingCreateResponse;
    const measurementId = created.id;

    if (!measurementId) {
      return "❌ Ошибка Globalping: не получен ID созданного замера.";
    }

    // 2. Initial wait of 3 seconds as required by specification
    await sleep(3000);

    // 3. Query results (with up to 2 extra retries if probes are still finishing)
    let measurementData: GlobalpingMeasurementResponse | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const statusRes = await fetch(`https://api.globalping.io/v1/measurements/${measurementId}`, {
        headers: {
          "User-Agent": "AmneziaWG-Admin-Bot/1.0",
        },
      });

      if (!statusRes.ok) {
        return `❌ Ошибка получения статуса замера (HTTP ${statusRes.status}): ${statusRes.statusText}`;
      }

      measurementData = (await statusRes.json()) as GlobalpingMeasurementResponse;

      const allFinished =
        measurementData.status === "finished" ||
        (Boolean(measurementData.results?.length) &&
          measurementData.results!.every((r) => r.result.status === "finished" || r.result.status === "failed"));

      if (allFinished) {
        break;
      }

      if (attempt < 2) {
        await sleep(2000);
      }
    }

    if (!measurementData || !measurementData.results || measurementData.results.length === 0) {
      return (
        "⚠️ *Результаты замера не получены.*\n" +
        "В настоящий момент зонды Globalping в РФ не ответили или перегружены. Попробуйте повторить замер позже."
      );
    }

    // 4. Format concise report
    const lines: string[] = [
      "🌐 *Доступность ноды из РФ (Globalping)*",
      `🎯 *Цель:* \`${host}\`\n`,
    ];

    for (const item of measurementData.results) {
      const city = item.probe.city || "Россия";
      const network = item.probe.network
        ? `AS${item.probe.asn ?? "?"} (${item.probe.network})`
        : item.probe.asn
        ? `AS${item.probe.asn}`
        : "Неизвестный ASN";

      if (item.result.status === "failed") {
        lines.push(`📍 *${city}* — ${network}\n   🔴 *Ошибка:* замер не удался`);
        continue;
      }

      const stats = item.result.stats;
      const avgPing =
        stats?.avg !== null && stats?.avg !== undefined
          ? `${stats.avg.toFixed(1)} ms`
          : "н/д";
      const loss =
        stats?.loss !== null && stats?.loss !== undefined
          ? `${stats.loss}%`
          : "н/д";

      let statusEmoji = "🟢";
      if (stats?.loss && stats.loss > 0) {
        statusEmoji = stats.loss >= 100 ? "🔴" : "🟡";
      }

      lines.push(
        `📍 *${city}* — ${network}\n   ${statusEmoji} Пинг: *${avgPing}* | Потери: *${loss}*`
      );
    }

    lines.push(`\n🕒 _Замер завершен: ${new Date().toLocaleTimeString("ru-RU")}_`);

    return lines.join("\n");
  } catch (error: any) {
    return `❌ Ошибка проверки доступности из РФ:\n${error?.message || String(error)}`;
  }
}

import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 128 * 1024;
const MAX_RETAINED_DAYS = 40;

function emptyCounters() {
  return { requests: 0, generated: 0, inputTokens: 0, outputTokens: 0 };
}

function safeCounter(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function normalizeCounters(value) {
  return {
    requests: safeCounter(value?.requests),
    generated: safeCounter(value?.generated),
    inputTokens: safeCounter(value?.inputTokens),
    outputTokens: safeCounter(value?.outputTokens),
  };
}

function dateKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function monthKey(now) {
  return dateKey(now).slice(0, 7);
}

function validateState(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !value.days || typeof value.days !== "object") {
    return { schemaVersion: SCHEMA_VERSION, days: {} };
  }
  const days = {};
  for (const key of Object.keys(value.days).sort().slice(-MAX_RETAINED_DAYS)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      days[key] = normalizeCounters(value.days[key]);
    }
  }
  return { schemaVersion: SCHEMA_VERSION, days };
}

function sumCounters(counters) {
  return counters.reduce(
    (total, value) => ({
      requests: total.requests + value.requests,
      generated: total.generated + value.generated,
      inputTokens: total.inputTokens + value.inputTokens,
      outputTokens: total.outputTokens + value.outputTokens,
    }),
    emptyCounters(),
  );
}

export class AiUsageLedger {
  constructor({ workspaceRoot, statePath, dailyRequestLimit, monthlyRequestLimit }, {
    now = () => Date.now(),
  } = {}) {
    const root = path.resolve(workspaceRoot);
    const absolutePath = path.resolve(root, statePath);
    if (absolutePath === root || !absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new Error("AI usage state must stay within the project workspace.");
    }
    this.path = absolutePath;
    this.dailyRequestLimit = safeCounter(dailyRequestLimit);
    this.monthlyRequestLimit = safeCounter(monthlyRequestLimit);
    this.now = now;
    this.state = { schemaVersion: SCHEMA_VERSION, days: {} };
    this.loadPromise = null;
    this.writePromise = Promise.resolve();
  }

  async load() {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        let handle;
        try {
          handle = await fs.open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const stats = await handle.stat();
          if (!stats.isFile() || stats.size > MAX_STATE_BYTES) {
            throw new Error("invalid AI usage state");
          }
          this.state = validateState(JSON.parse(await handle.readFile("utf8")));
        } catch (error) {
          if (error?.code === "ENOENT") {
            this.state = { schemaVersion: SCHEMA_VERSION, days: {} };
          } else {
            throw error;
          }
        } finally {
          await handle?.close().catch(() => {});
        }
      })();
    }
    await this.loadPromise;
  }

  async getSnapshot(now = this.now()) {
    await this.load();
    const todayKey = dateKey(now);
    const currentMonth = monthKey(now);
    const today = normalizeCounters(this.state.days[todayKey]);
    const month = sumCounters(
      Object.entries(this.state.days)
        .filter(([key]) => key.startsWith(currentMonth))
        .map(([, value]) => normalizeCounters(value)),
    );
    return {
      today,
      month,
      dailyRequestLimit: this.dailyRequestLimit,
      monthlyRequestLimit: this.monthlyRequestLimit,
    };
  }

  async canRequest(now = this.now()) {
    const snapshot = await this.getSnapshot(now);
    const dailyAllowed = !snapshot.dailyRequestLimit || snapshot.today.requests < snapshot.dailyRequestLimit;
    const monthlyAllowed = !snapshot.monthlyRequestLimit || snapshot.month.requests < snapshot.monthlyRequestLimit;
    return {
      allowed: dailyAllowed && monthlyAllowed,
      reason: !dailyAllowed ? "daily-limit" : !monthlyAllowed ? "monthly-limit" : "allowed",
      snapshot,
    };
  }

  async record({ generated = false, inputTokens = 0, outputTokens = 0 } = {}, now = this.now()) {
    await this.load();
    this.writePromise = this.writePromise.catch(() => {}).then(async () => {
      const key = dateKey(now);
      const counters = normalizeCounters(this.state.days[key]);
      counters.requests += 1;
      counters.generated += generated ? 1 : 0;
      counters.inputTokens += safeCounter(inputTokens);
      counters.outputTokens += safeCounter(outputTokens);
      this.state.days[key] = counters;

      const retained = Object.keys(this.state.days).sort().slice(-MAX_RETAINED_DAYS);
      this.state.days = Object.fromEntries(retained.map((day) => [day, this.state.days[day]]));

      const directory = path.dirname(this.path);
      const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      let handle;
      try {
        handle = await fs.open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        await handle.writeFile(`${JSON.stringify(this.state)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, this.path);
        await fs.chmod(this.path, 0o600);
      } finally {
        await handle?.close().catch(() => {});
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    });
    await this.writePromise;
    return this.getSnapshot(now);
  }
}

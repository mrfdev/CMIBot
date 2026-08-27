export function hasHealthyServiceLog(logText) {
  if (/LookupBot connected as .+\./.test(logText)) {
    return true;
  }

  for (const line of String(logText).split("\n")) {
    if (!line.trim().startsWith("{")) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (record?.event === "discord.connected" && record?.level === "info" && record?.ready === true) {
        return true;
      }
    } catch {
      // Ignore unrelated or partial log lines while the service is starting.
    }
  }
  return false;
}

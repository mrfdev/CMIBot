import path from "node:path";
import { loadPrivateEnvironment } from "./privateEnvironment.js";

await loadPrivateEnvironment({
  allowMissing: true,
  environmentPath: process.env.CMIBOT_ENV_PATH || path.join(process.cwd(), ".env"),
});

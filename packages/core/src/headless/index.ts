/**
 * Public surface của `packages/core/src/headless/` (v1.05, Đội T3).
 */
export {
  HEADLESS_DEFAULT_HOST,
  HEADLESS_DEFAULT_PORT,
  HEADLESS_LOG_FILE,
  HEADLESS_PID_FILE,
  HEADLESS_VERSION,
  headlessPidStatus,
  isProcessAlive,
  probeHeadlessHealth,
  readPidFile,
  removePidFile,
  startHeadlessServer,
  writePidFile,
} from './server';
export type { HeadlessHealth, HeadlessServerHandle, HeadlessServerOptions, HeadlessStatusInfo } from './server';

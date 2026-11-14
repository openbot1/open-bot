/**
 * Public surface của `packages/core/src/doctor/` (v1.05, Đội T3).
 */
export {
  DEFAULT_DATA_DIR,
  DOCTOR_DISK_FAIL_BYTES,
  DOCTOR_DISK_WARN_BYTES,
  DOCTOR_ENV_PROVIDERS,
  DOCTOR_HEADLESS_PORT,
  DOCTOR_MIN_NODE_MAJOR,
  DOCTOR_OLLAMA_PORT,
  DOCTOR_RAM_WARN_BYTES,
  doctorExitCode,
  renderDoctorReport,
  runDoctorChecks,
} from './doctor';
export type { DoctorCheck, DoctorCheckStatus, DoctorDeps, DoctorReport } from './doctor';

// v1.06 (Đội T3): runDoctor 11-check + format text/JSON (xem doctor.ts).
// Type DoctorCheck/DoctorReport của bản này khác bản v1.05 nên export
// với tên V106 để không trùng.
export { runDoctor, formatDoctorReport, formatDoctorReportJson, formatDoctorCheckLine } from './doctor';
export type { RunDoctorOptions } from './doctor';
export {
  checkCliEngines,
  checkCpu,
  checkDataDir,
  checkDisk,
  checkHarnessLoopback,
  checkHarnessPort,
  checkMemory,
  checkNodeVersion,
  checkNpmVersion,
  checkOs,
  checkVault,
  enginesFromSnapshot,
  formatBytes,
  parseMajorVersion,
  resolveDoctorEnv,
} from './checks';
export type { DoctorEnv } from './checks';
export { DEFAULT_DOCTOR_HARNESS_PORT, DEFAULT_DOCTOR_THRESHOLDS, DOCTOR_CHECK_IDS } from './types';
export type {
  DoctorCategory,
  DoctorCheck as DoctorCheckV106,
  DoctorCheckId,
  DoctorCheckStatus as DoctorCheckStatusV106,
  DoctorEngineInfo,
  DoctorReport as DoctorReportV106,
  DoctorThresholds,
} from './types';

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

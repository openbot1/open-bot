/**
 * Khóa ký Agent Card lưu trong Vault, v1.07 Đội T3.
 *
 * Trước đây key ký card chỉ sống trong file PEM (`a2a-signing-key.pem`,
 * xem `signing.ts` — `loadOrCreateA2aSigningKey`). File PEM vẫn chạy,
 * nhưng app đã có Vault mã hoá (AES-256-GCM, xem `vault/vault.ts`)
 * làm chỗ chuẩn cho mọi secret: module này đưa key ký card vào Vault
 * để key được mã hoá lúc nghỉ thay vì nằm plaintext trên đĩa.
 *
 * Namespace riêng: `'a2a'` — tách khỏi `'provider'`/`'mcp'`/`'oauth'`
 * theo đúng quy tắc "mỗi loại secret một namespace" của Vault.
 * Key trong namespace: `'signing-key'` (private key PEM PKCS#8).
 * Giá trị lưu trong Vault là PEM — Vault mã hoá trước khi ghi đĩa
 * nên PEM không bao giờ nằm plaintext trong `vault.json`.
 *
 * Luồng dùng:
 *  1. `loadOrCreateVaultSigningKey(vault)` — đọc từ Vault; chưa có
 *     thì tạo key mới + lưu vào Vault (trả kèm `created: true`).
 *  2. Server truyền keyPair vào `createA2aServer({ signer })` như cũ
 *     — không đổi API server.
 *  3. `rotateVaultSigningKey(vault)` — tạo key mới, ghi đè Vault,
 *     trả keyPair mới (keyId đổi → client trust-on-first-use sẽ thấy
 *     key mới, giống rotate file PEM: user phải xác nhận lại).
 *  4. `removeVaultSigningKey(vault)` — xoá key khỏi Vault (vd user
 *     muốn quay về card không ký, hoặc đổi sang file PEM).
 *
 * Fallback: khi caller chưa có Vault (test, CLI nhanh), dùng
 * `loadOrCreateA2aSigningKey(filePath)` trong `signing.ts` như cũ.
 * Module này KHÔNG tự tạo Vault — caller truyền Vault đã mở sẵn
 * (main process sở hữu `vault.json` + encryptor).
 */

import { generateA2aSigningKey, loadA2aSigningKeyFromPem, type A2aSigningKeyPair } from './signing';

/** Namespace Vault riêng cho khóa ký A2A. */
export const A2A_VAULT_NAMESPACE = 'a2a';

/** Key của private key PEM ký Agent Card trong namespace `a2a`. */
export const A2A_VAULT_SIGNING_KEY = 'signing-key';

/**
 * Mặt tối thiểu của Vault mà module này cần — dùng structural typing
 * để không import class Vault (tránh cycle import): bất kỳ object
 * nào có 3 method này đều dùng được (Vault thật, ScopedVault, fake
 * trong test).
 */
export interface VaultSigningKeyStore {
  getSecret(namespace: string, key: string): string | null;
  setSecret(namespace: string, key: string, value: string): void;
  deleteSecret(namespace: string, key: string): boolean;
}

/** Kết quả load/create key ký từ Vault. */
export interface VaultSigningKeyResult {
  keyPair: A2aSigningKeyPair;
  /** true khi key vừa được tạo mới (chưa từng có trong Vault). */
  created: boolean;
}

/**
 * Đọc key ký từ Vault, hoặc tạo mới + lưu khi chưa có. PEM trong
 * Vault hỏng (không phải Ed25519) → throw lỗi rõ ràng, KHÔNG tự
 * ghi đè (ghi đè đổi keyId, client đã trust key cũ sẽ báo key đổi
 * — user phải xoá tay bằng `removeVaultSigningKey` khi thật sự
 * muốn rotate).
 */
export function loadOrCreateVaultSigningKey(store: VaultSigningKeyStore): VaultSigningKeyResult {
  const stored = store.getSecret(A2A_VAULT_NAMESPACE, A2A_VAULT_SIGNING_KEY);
  if (stored !== null && stored.trim().length > 0) {
    try {
      return { keyPair: loadA2aSigningKeyFromPem(stored), created: false };
    } catch (err) {
      throw new Error(
        `Khóa ký Agent Card trong Vault (namespace '${A2A_VAULT_NAMESPACE}') hỏng — ` +
          `xoá bằng removeVaultSigningKey rồi tạo lại (client đã trust sẽ thấy key đổi): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  const created = generateA2aSigningKey();
  store.setSecret(A2A_VAULT_NAMESPACE, A2A_VAULT_SIGNING_KEY, created.privateKeyPem);
  return { keyPair: created, created: true };
}

/**
 * Đọc key ký từ Vault, trả null khi chưa có (không tạo mới).
 * Dùng khi caller chỉ muốn ký nếu key đã tồn tại (vd server chạy
 * với card không ký khi chưa setup key).
 */
export function loadVaultSigningKey(store: VaultSigningKeyStore): A2aSigningKeyPair | null {
  const stored = store.getSecret(A2A_VAULT_NAMESPACE, A2A_VAULT_SIGNING_KEY);
  if (stored === null || stored.trim().length === 0) return null;
  return loadA2aSigningKeyFromPem(stored);
}

/**
 * Xoay key ký: tạo keypair mới, ghi đè Vault, trả keyPair mới.
 * KeyId đổi → Agent Card ký sau đó mang keyId mới; client
 * trust-on-first-use thấy key mới (firstSeen=true) và user xác
 * nhận lại. Key cũ không khôi phục được — chỉ rotate khi thật sự
 * cần (lộ key, đổi máy).
 */
export function rotateVaultSigningKey(store: VaultSigningKeyStore): A2aSigningKeyPair {
  const next = generateA2aSigningKey();
  store.setSecret(A2A_VAULT_NAMESPACE, A2A_VAULT_SIGNING_KEY, next.privateKeyPem);
  return next;
}

/** Xoá key ký khỏi Vault. Trả true khi đã có key để xoá. */
export function removeVaultSigningKey(store: VaultSigningKeyStore): boolean {
  return store.deleteSecret(A2A_VAULT_NAMESPACE, A2A_VAULT_SIGNING_KEY);
}

/**
 * True khi Vault đang giữ một key ký (không đọc/giải mã nội dung
 * ngoài việc kiểm tra tồn tại — getSecret trả null khi không có).
 */
export function hasVaultSigningKey(store: VaultSigningKeyStore): boolean {
  const stored = store.getSecret(A2A_VAULT_NAMESPACE, A2A_VAULT_SIGNING_KEY);
  return stored !== null && stored.trim().length > 0;
}

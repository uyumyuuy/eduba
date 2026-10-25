export type StorageProtection = "enabled" | "disabled" | "unknown";
export const STORAGE_PROTECTION_CHANGED = "eduba-browser-storage-protection-changed";

export async function storageProtection(): Promise<StorageProtection> {
  try {
    if (!navigator.storage?.persisted) return "unknown";
    return await navigator.storage.persisted() ? "enabled" : "disabled";
  } catch { return "unknown"; }
}

export async function requestStorageProtection(): Promise<void> {
  try { await navigator.storage?.persist?.(); }
  catch { /* Saving can continue even if persistence is unavailable or denied. */ }
  finally { window.dispatchEvent(new Event(STORAGE_PROTECTION_CHANGED)); }
}

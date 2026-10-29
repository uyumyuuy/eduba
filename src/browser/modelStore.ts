function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("eduba-browser-models", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("models");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function storeModel(file: File): Promise<string> {
  const db = await database();
  const id = `model:${crypto.randomUUID()}/${file.name}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("models", "readwrite");
      transaction.objectStore("models").put(file, id);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    return id;
  } finally { db.close(); }
}
export async function loadModel(id: string): Promise<Blob | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("models", "readonly");
      const request = transaction.objectStore("models").get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

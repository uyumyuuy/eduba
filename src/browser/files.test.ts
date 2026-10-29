import { describe, it, expect, vi, afterEach } from "vitest";
import { dialogSave, localFile, writeLocalFile, type LocalFileHandle } from "./files";

afterEach(() => { vi.unstubAllGlobals(); });
function handle() {
  let file = new File(["original"], "project.eduba", { lastModified: 1 });
  const stream = { write: vi.fn(async (_bytes: Blob | Uint8Array) => {}), close: vi.fn(async () => { file = new File(["saved"], "project.eduba", { lastModified: 2 }); }), abort: vi.fn(async () => {}) };
  const value: LocalFileHandle = { name: file.name, getFile: async () => file, createWritable: vi.fn(async () => stream), queryPermission: async () => "granted", requestPermission: async () => "granted" };
  return { value, stream, change: () => { file = new File(["external change"], file.name, { lastModified: 3 }); } };
}
describe("browser local file saving", () => {
  it("acquires the selected save handle and refreshes its snapshot after writing", async () => {
    const { value, stream } = handle();
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn(async () => value) });
    try {
      const path = await dialogSave({ defaultPath: "project.eduba", filters: [{ name: "Eduba", extensions: ["eduba"] }] });
      const target = localFile(path!);
      await writeLocalFile(target, Uint8Array.of(1, 2, 3));
      expect(stream.write).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3));
      expect(stream.close).toHaveBeenCalled();
      expect(target.file?.lastModified).toBe(2);
    } finally { Reflect.deleteProperty(window, "showSaveFilePicker"); }
  });
  it("does not overwrite a project modified outside Eduba", async () => {
    const { value, change } = handle();
    const target = { name: value.name, handle: value, file: await value.getFile() };
    change();
    await expect(writeLocalFile(target, Uint8Array.of(1))).rejects.toThrow("changed outside");
    expect(value.createWritable).not.toHaveBeenCalled();
  });
  it("aborts failed writes and retains the original snapshot for retry", async () => {
    const { value, stream } = handle();
    const target = { name: value.name, handle: value, file: await value.getFile() };
    stream.write.mockRejectedValueOnce(new Error("Disk full"));
    await expect(writeLocalFile(target, Uint8Array.of(1))).rejects.toThrow("Disk full");
    expect(stream.abort).toHaveBeenCalled();
    expect(stream.close).not.toHaveBeenCalled();
    expect(target.file.lastModified).toBe(1);
  });
});

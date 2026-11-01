import { IslandsError } from "./errors.ts";

const BADF = 8;
const INVAL = 28;
const SPIPE = 70;

/** Preview 1 prerequisites only: empty stdin/environment, discarded stdout/stderr, no preopens. */
export function wasiImports(memory: () => WebAssembly.Memory): WebAssembly.ModuleImports {
  const view = () => new DataView(memory().buffer);
  const bytes = (pointer: number, length: number) => new Uint8Array(memory().buffer, pointer >>> 0, length >>> 0);
  const emptySizes = (count: number, size: number) => {
    const data = view();
    data.setUint32(count >>> 0, 0, true);
    data.setUint32(size >>> 0, 0, true);
    return 0;
  };
  const stdio = new Set([0, 1, 2]);
  return {
    args_get: () => 0,
    args_sizes_get: emptySizes,
    environ_get: () => 0,
    environ_sizes_get: emptySizes,
    clock_time_get: (id: number, _precision: bigint, pointer: number) => {
      if (id !== 0 && id !== 1) return INVAL;
      const nanoseconds = id === 0 ? BigInt(Date.now()) * 1_000_000n : BigInt(Math.floor(performance.now() * 1_000_000));
      view().setBigUint64(pointer >>> 0, nanoseconds, true);
      return 0;
    },
    clock_res_get: (id: number, pointer: number) => {
      if (id !== 0 && id !== 1) return INVAL;
      view().setBigUint64(pointer >>> 0, 1_000_000n, true);
      return 0;
    },
    random_get: (pointer: number, length: number) => {
      const target = bytes(pointer, length);
      for (let offset = 0; offset < target.length; offset += 65536) {
        globalThis.crypto.getRandomValues(target.subarray(offset, offset + 65536));
      }
      return 0;
    },
    fd_prestat_get: () => BADF,
    fd_prestat_dir_name: () => BADF,
    fd_fdstat_get: (fd: number, pointer: number) => {
      if (!stdio.has(fd)) return BADF;
      bytes(pointer, 24).fill(0);
      const data = view();
      data.setUint8(pointer >>> 0, 2); // character device
      data.setBigUint64((pointer >>> 0) + 8, fd === 0 ? 2n : 64n, true); // read / write
      return 0;
    },
    fd_read: (fd: number, _iov: number, _count: number, read: number) => {
      if (fd !== 0 || !stdio.has(fd)) return BADF;
      view().setUint32(read >>> 0, 0, true);
      return 0;
    },
    fd_write: (fd: number, iov: number, count: number, written: number) => {
      if ((fd !== 1 && fd !== 2) || !stdio.has(fd)) return BADF;
      const data = view();
      let total = 0;
      bytes(iov, (count >>> 0) * 8);
      for (let index = 0; index < (count >>> 0); index++) {
        const offset = (iov >>> 0) + index * 8;
        const length = data.getUint32(offset + 4, true);
        bytes(data.getUint32(offset, true), length);
        total += length;
        if (total > 0xffffffff) return INVAL;
      }
      data.setUint32(written >>> 0, total, true);
      return 0;
    },
    fd_close: (fd: number) => stdio.delete(fd) ? 0 : BADF,
    fd_seek: (fd: number) => stdio.has(fd) ? SPIPE : BADF,
    fd_tell: (fd: number) => stdio.has(fd) ? SPIPE : BADF,
    proc_exit: (status: number) => { throw new IslandsError("ENGINE_EXIT", `Core exited with status ${status}`); },
  };
}

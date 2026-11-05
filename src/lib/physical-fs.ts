import { createRequire } from "node:module";
import nativeFs from "node:fs";

// Electron's patched fs treats .asar files as virtual directories. User paths
// must always refer to physical objects; module loading remains untouched.
const require = createRequire(import.meta.url);
const physicalFs: typeof nativeFs = process.versions.electron
  ? require("original-fs") as typeof nativeFs
  : nativeFs;
export default physicalFs;
export const physicalPromises = physicalFs.promises;

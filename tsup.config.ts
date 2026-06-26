import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default {
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  define: {
    __ILINK_VERSION__: JSON.stringify(pkg.version ?? "0.0.0"),
    __ILINK_APP_ID__: JSON.stringify(pkg.ilink_appid ?? "bot"),
  },
};

import { build } from "esbuild"
import { resolve } from "node:path"
import { readFile } from "node:fs/promises"

await build({
  entryPoints: ["vendor.ts"], bundle: true, platform: "node",
  format: "cjs", target: "es2022", minify: true,
  outfile: "../mtproto.js",
  metafile: true,
  plugins: [{
    name: "scripting-compatibility",
    setup(builder) {
      builder.onResolve({ filter: /^cifrante$/ }, () => ({
        path: resolve("node_modules/cifrante/dist/cifrante.cjs"),
      }))
      builder.onLoad({ filter: /teleproto\/network\/transport\/socket\/NetSocket\.js$/ }, async ({ path }) => {
        const original = await readFile(path, "utf8")
        const old = "if (direct) direct.connect(port, ip, ready);"
        const replacement = "if (direct) direct.connect({ port, host: ip, noDelay: true, keepAlive: this.keepAliveInterval > 0, keepAliveInitialDelay: Math.max(0, this.keepAliveInterval) }, ready);"
        if (!original.includes(old)) throw new Error("Telegram socket adapter changed")
        return {
          contents: original.replace(old, replacement).replace("socket.unref?.();", ""),
          loader: "js",
        }
      })
    },
  }],
}).then(result => {
  console.log(Object.values(result.metafile.outputs)[0].imports.map(item => item.path).join(", "))
})

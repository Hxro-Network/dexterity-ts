const esbuild = require("esbuild");
const inlineImage = require("esbuild-plugin-inline-image");

esbuild.build({
    entryPoints: ["./src/index.ts"],
    outfile: "./dist/dexterity.ts",
    bundle: true,
    minify: true,
    sourcemap: true,
    loader: {
//        ".js": "jsx",
    },
    plugins: [inlineImage()],
    define: {
//        "process.env.NODE_DEBUG": "\"debug\"",
//        "process.env.NODE_ENV": "\"production\"",
//        "global": "window"
    },
}).catch(() => process.exit(1));

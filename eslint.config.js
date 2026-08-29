const prettierConfig = require("eslint-config-prettier");

module.exports = [
    {
        ignores: ["node_modules/", "zorr-deobfuscator/", "pathfinding/map.json", "pathfinding/*.min.js"],
    },
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: "commonjs",
            globals: {
                require: "readonly",
                module: "writable",
                exports: "writable",
                process: "readonly",
                console: "readonly",
                Buffer: "readonly",
                __dirname: "readonly",
                __filename: "readonly",
                setTimeout: "readonly",
                setInterval: "readonly",
                clearTimeout: "readonly",
                clearInterval: "readonly",
                setImmediate: "readonly",
                TextDecoder: "readonly",
                TextEncoder: "readonly",
                URL: "readonly",
                URLSearchParams: "readonly",
                fetch: "readonly",
                WebSocket: "readonly",
            },
        },
        linterOptions: {
            reportUnusedDisableDirectives: true,
        },
        rules: {
            "no-undef": "error",
            "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
            "no-constant-condition": ["error", { checkLoops: false }],
            "no-fallthrough": "error",
            "no-cond-assign": "error",
            "prefer-const": "warn",
            eqeqeq: ["warn", "smart"],
        },
    },
    {
        files: ["test/**/*.js"],
        languageOptions: {
            globals: { describe: "readonly", it: "readonly" },
        },
    },
    prettierConfig,
];

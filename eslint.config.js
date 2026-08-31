import prettierConfig from "eslint-config-prettier";

export default [
    {
        ignores: [
            "node_modules/",
            "zorr-deobfuscator/",
            "pathfinding/map.json",
            "pathfinding/*.min.js",
            "pathfinding/index.html",
        ],
    },
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: "module",
            globals: {
                process: "readonly",
                console: "readonly",
                Buffer: "readonly",
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
                import: "readonly",
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
        files: ["public/**/*.js"],
        languageOptions: {
            sourceType: "script",
            globals: {
                document: "readonly",
                window: "writable",
                alert: "readonly",
                EventSource: "readonly",
            },
        },
        rules: {
            // Inline onclick="" handlers reference these top-level functions,
            // which ESLint cannot see — silence the false "never used" reports.
            "no-unused-vars": [
                "warn",
                {
                    args: "none",
                    caughtErrors: "none",
                    varsIgnorePattern:
                        "^(send|toggle|open|close|start|stop|switch|render|select|save|load|delete|add|preview|play|route|init|on|apply|escapeHtml|update|clear|restore|handle|buildDistanceMap|findPathLocal)",
                },
            ],
        },
    },
    prettierConfig,
];

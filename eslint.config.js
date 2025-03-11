// eslint.config.js
import balenaLint from "@balena/lint/config/eslint.config.js";

export default [
    ...balenaLint,

    // Overrides
    {
        rules: {
            // We need the `number` field to test some GH API responses, which
            // this rule doesn't like as an identifier.
            "id-denylist": "off"
        }
    }
];

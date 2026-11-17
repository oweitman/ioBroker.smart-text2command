import prettierConfig from '@iobroker/eslint-config/prettier.config.mjs';

export default {
    ...prettierConfig,
    // uncomment next line if you prefer double quotes
    // singleQuote: false,
    table_allowed_elements: ['img'],
    overrides: [
        ...(prettierConfig.overrides ?? []),
        {
            files: ['*.json', '*.json5', '*.jsonc'],
            options: {
                tabWidth: 2,
            },
        },
    ],
};

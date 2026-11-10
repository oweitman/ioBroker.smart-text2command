import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        files: ['src/**/*.ts', 'test/**/*.ts'],
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
            'jsdoc/no-blank-blocks': 'off',
        },
    },
    {
        files: ['src/**/*.d.ts'],
        rules: { '@typescript-eslint/no-empty-object-type': 'off' },
    },
];

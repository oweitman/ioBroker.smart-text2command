import config from '@iobroker/eslint-config';

export default [
    {
        // Dieses Objekt muss allein stehen, damit es global gilt!
        ignores: ['documentation/examples/**'],
    },
    ...config,
    {
        files: ['src/**/*.ts', 'src-admin/**/*.tsx', 'test/**/*.ts'],
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

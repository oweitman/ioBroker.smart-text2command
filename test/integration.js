const path = require("path");
const { tests } = require("@iobroker/testing");

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite('NLP initialization', getHarness => {
            let harness;
            before(() => { harness = getHarness(); });

            it('trains the baseline model and reports ready', async function () {
                this.timeout(60_000);
                let timer;
                const ready = new Promise((resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('NLP model did not become ready')), 55_000);
                    harness.on('stateChange', (id, state) => {
                        if (id === 'smart-text2command.0.info.modelStatus' && state?.val === 'ready') resolve();
                        if (id === 'smart-text2command.0.info.modelStatus' && state?.val === 'error') reject(new Error('NLP model initialization failed'));
                    });
                });
                try {
                    await harness.startAdapterAndWait();
                    await ready;
                } finally {
                    clearTimeout(timer);
                }
            });
        });
    },
});

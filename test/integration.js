const path = require("path");
const { readFile } = require("node:fs/promises");
const { tests } = require("@iobroker/testing");

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite('NLP initialization', getHarness => {
            let harness;
            before(() => { harness = getHarness(); });

            it('trains the baseline model and reports ready', async function () {
                this.timeout(60_000);
                await harness.objects.setObject('0_userdata.0.test_lampe', {
                    _id: '0_userdata.0.test_lampe',
                    type: 'channel',
                    common: { name: 'Testlampe' },
                    native: {},
                });
                await harness.objects.setObject('0_userdata.0.test_lampe.POWER', {
                    _id: '0_userdata.0.test_lampe.POWER',
                    type: 'state',
                    common: { name: 'Power', role: 'switch', type: 'boolean', read: true, write: true },
                    native: {},
                });
                await harness.objects.setObject('0_userdata.0.test_lampe.HELLIGKEIT', {
                    _id: '0_userdata.0.test_lampe.HELLIGKEIT',
                    type: 'state',
                    common: { name: 'Helligkeit', role: 'level.brightness', type: 'number', read: true, write: true, min: 0, max: 100 },
                    native: {},
                });
                await harness.objects.setObject('enum.rooms.wohnzimmer', {
                    _id: 'enum.rooms.wohnzimmer',
                    type: 'enum',
                    common: { name: 'Wohnzimmer', members: ['0_userdata.0.test_lampe'] },
                    native: {},
                });
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
                    const saved = JSON.parse(await readFile(path.join(
                        harness.testControllerDir,
                        "..",
                        "..",
                        "iobroker-data",
                        "smart-text2command.0",
                        "devices-v1.json",
                    ), "utf8"));
                    const lamp = saved.data.devices.find(device => device.id === "0_userdata.0.test_lampe");
                    if (
                        !lamp ||
                        lamp.discoveredCapabilities.length !== 2 ||
                        !lamp.roomIds.includes('enum.rooms.wohnzimmer')
                    ) {
                        throw new Error("The channel, its states and room were not discovered as one device");
                    }
                    const analyzed = new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error('Analysis state did not finish')), 10_000);
                        harness.on('stateChange', (id, state) => {
                            if (id === 'smart-text2command.0.output.status' && state?.val === 'done') {
                                clearTimeout(timeout);
                                resolve();
                            }
                        });
                    });
                    await harness.states.setState('smart-text2command.0.input.text', { val: 'Schalte Lampe ein', ack: false });
                    await analyzed;
                    const result = await harness.states.getState('smart-text2command.0.output.result');
                    if (!result || JSON.parse(result.val).status !== 'rejected') throw new Error('State analysis returned no rejection for unapproved device');
                } finally {
                    clearTimeout(timer);
                }
            });
        });
    },
});

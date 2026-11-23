import { expect } from 'chai';
import {
    colorValue,
    matchEffectiveColor,
    matchNamedColor,
    matchNamedTemperature,
    namedColors,
    validateCustomColors,
} from '../src/commands/NamedColors';

describe('named colors', () => {
    it('loads unique names including alternate names from one catalog', () => {
        expect(namedColors('de')).to.have.length.greaterThan(400);
        expect(matchNamedColor('Stelle die Lampe auf Türkis', 'de')?.hex).to.equal('#00ffff');
        expect(matchNamedColor('Stelle die Lampe auf Lila', 'de')?.hex).to.equal('#800080');
        expect(matchNamedColor('Stelle die Lampe auf Pink', 'de')?.hex).to.equal('#ff69b4');
        expect(matchNamedColor('Stelle die Lampe auf Strohgelb', 'de')?.hex).to.equal('#f7e780');
    });

    it('writes RGBW with an unused white channel in the first version', () => {
        expect(colorValue('#FF8040', 'level.color.rgb')).to.equal('#ff8040');
        expect(colorValue('#FF8040', 'level.color.rgbw')).to.equal('#ff804000');
    });

    it('allows an explicit unique custom override and maps white names to Kelvin', () => {
        const custom = validateCustomColors([{ language: 'de', name: 'Lila', hex: '#112233' }]);
        expect(matchEffectiveColor('Lila', 'de', custom)?.hex).to.equal('#112233');
        expect(matchNamedTemperature('Warmweiß', 'de')?.kelvin).to.equal(2200);
        expect(() =>
            validateCustomColors([
                { language: 'de', name: 'Lila', hex: '#112233' },
                { language: 'de', name: 'lila', hex: '#445566' },
            ]),
        ).to.throw('Duplicate custom color name');
    });
});

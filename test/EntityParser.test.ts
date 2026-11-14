import { expect } from 'chai';
import { parseEntities } from '../src/nlp/EntityParser';

describe('entity parser', () => {
    it('parses localized values and units', () => {
        const german = parseEntities('Stelle die Heizung auf 21,5 Grad', 'de');
        expect(german.entities.find(item => item.type === 'temperature')?.value).to.equal(21.5);
        const english = parseEntities('Dim the lamp to 40 %', 'en');
        expect(english.entities.find(item => item.type === 'percent')?.value).to.equal(40);
        expect(parseEntities('Set value to 21.5', 'en').entities.find(item => item.type === 'number')?.value).to.equal(
            21.5,
        );
    });

    it('parses spoken German and English numbers without rewriting device names', () => {
        const german = parseEntities('Stelle die Heizung auf fünfundzwanzig Grad', 'de');
        expect(german.entities.find(item => item.type === 'temperature')).to.include({ value: 25 });
        expect(
            parseEntities('Stelle die Lamellen auf fünfzig Prozent', 'de').entities.find(
                item => item.type === 'percent',
            ),
        ).to.include({ value: 50 });
        const splitGerman = parseEntities('Stelle die Lamellen auf fünf und zwanzig Prozent', 'de');
        expect(splitGerman.entities.find(item => item.type === 'percent')).to.include({ value: 25 });
        expect(splitGerman.unsupported).not.to.include('multipleActions');
        expect(
            parseEntities('Set the brightness to seventy five percent', 'en').entities.find(
                item => item.type === 'percent',
            ),
        ).to.include({ value: 75 });
        expect(
            parseEntities('Set temperature to twenty one point five degrees', 'en').entities.find(
                item => item.type === 'temperature',
            ),
        ).to.include({ value: 21.5 });
        expect(
            parseEntities('Set the value to one hundred twenty five', 'en').entities.find(
                item => item.type === 'number',
            ),
        ).to.include({ value: 125 });
        const withAnd = parseEntities('Set the value to one hundred and twenty five', 'en');
        expect(withAnd.entities.find(item => item.type === 'number')).to.include({ value: 125 });
        expect(withAnd.unsupported).not.to.include('multipleActions');
        expect(
            parseEntities('Set value to one hundred and twenty five and turn off the lamp', 'en').unsupported,
        ).to.include('multipleActions');
        expect(parseEntities('Schalte eine Lampe ein', 'de').entities.filter(item => item.type === 'number')).to.be
            .empty;
        expect(parseEntities('Switch constructor on', 'en').entities.filter(item => item.type === 'number')).to.be
            .empty;
    });

    it('reports a room only once when its ID and display name match', () => {
        const parsed = parseEntities('Welche Temperatur hat die Heizung im Wohnzimmer', 'de', [
            'wohnzimmer',
            'Wohnzimmer',
        ]);
        expect(parsed.entities.filter(entity => entity.type === 'room')).to.deep.equal([
            { type: 'room', value: 'wohnzimmer', start: 37, end: 47 },
        ]);
    });

    it('marks negation and unsupported group, exception, time, and multiple actions', () => {
        const parsed = parseEntities('Schalte nicht alle Lampen außer Küche morgen ein und aus', 'de', ['Küche']);
        expect(parsed.negated).to.equal(true);
        expect(parsed.unsupported).to.include.members(['group', 'exception', 'time', 'multipleActions']);
        expect(parsed.entities.find(item => item.type === 'room')?.value).to.equal('Küche');
        expect(parseEntities('Set temperature to 70 Fahrenheit', 'en').unsupported).to.include('unit');
        expect(parseEntities('Schalte die Lampe ein, setze die Heizung auf 21 Grad', 'de').unsupported).to.include(
            'multipleActions',
        );
    });
});

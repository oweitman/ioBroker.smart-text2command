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

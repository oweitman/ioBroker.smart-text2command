import { expect } from 'chai';
import { enumRelativeTarget, parseRelativeRequest, relativeTarget } from '../src/commands/RelativeValue';

describe('relative values', () => {
    it('recognizes intensity and computes a brightness step from the full range', () => {
        const request = parseRelativeRequest('Mach die Lampe etwas heller', 'de');
        expect(request).to.include({ property: 'brightness', direction: 'increase', intensity: 'small' });
        expect(relativeTarget(127, 0, 254, 'brightness', '%', request!)).to.equal(140);
    });

    it('uses the Celsius and Fahrenheit profiles and a half-degree Celsius grid', () => {
        const request = parseRelativeRequest('Stell die Heizung deutlich wärmer', 'de')!;
        expect(relativeTarget(20.5, 17, 26, 'temperature', '°C', request)).to.equal(23.5);
        expect(relativeTarget(68, 60, 80, 'temperature', '°F', request)).to.equal(74);
    });

    it('moves Kelvin in the opposite numeric direction for warmer light', () => {
        const request = parseRelativeRequest('Mach das Licht wärmer', 'de')!;
        expect(relativeTarget(5000, 2200, 6500, 'colorTemperature', 'K', request)).to.equal(4570);
    });

    it('rejects negation and incompatible explicit units', () => {
        expect(parseRelativeRequest('Mach die Lampe nicht heller', 'de')).to.equal(undefined);
        const request = parseRelativeRequest('Mach die Lampe um 2 Grad heller', 'de')!;
        expect(relativeTarget(50, 0, 100, 'brightness', '%', request)).to.equal(undefined);
    });

    it('distinguishes an endpoint from the maximum relative step', () => {
        const genericMaximum = parseRelativeRequest('Mach den venti im ventizimmer auf Maximum', 'de');
        expect(genericMaximum).to.include({ endpoint: 'max', property: undefined });
        expect(parseRelativeRequest('Mach den venti auf Minimum', 'de')).to.include({ endpoint: 'min' });
        expect(parseRelativeRequest('Set the fan to maximum', 'en')).to.include({ endpoint: 'max' });
        const endpoint = parseRelativeRequest('Mach die Lampe auf maximale Helligkeit', 'de')!;
        expect(endpoint.endpoint).to.equal('max');
        expect(relativeTarget(40, 0, 100, 'brightness', '%', endpoint)).to.equal(100);
        const relative = parseRelativeRequest('Mach die Lampe maximal heller', 'de')!;
        expect(relative.endpoint).to.equal(undefined);
        expect(relativeTarget(40, 0, 100, 'brightness', '%', relative)).to.equal(75);
        const open = parseRelativeRequest('Rollladen ganz öffnen', 'de')!;
        expect(relativeTarget(50, 0, 100, 'position', '%', open)).to.equal(0);
    });

    it('honors explicit amounts, overrides, inversion and the minimum based grid', () => {
        const request = parseRelativeRequest('Stell die Heizung um 2 Grad wärmer', 'de')!;
        expect(relativeTarget(20, 17, 26, 'temperature', '°C', request, { normal: 4 })).to.equal(22);
        expect(relativeTarget(20, 17, 26, 'temperature', '°C', request, { inverted: true })).to.equal(18);
        const small = parseRelativeRequest('Mach die Lampe etwas heller', 'de')!;
        expect(relativeTarget(127, 0, 254, 'brightness', '%', small, { step: 2 })).to.equal(140);
    });

    it('moves only through declared fan stages', () => {
        const request = parseRelativeRequest('Ventilator deutlich stärker', 'de')!;
        expect(enumRelativeTarget(2, [0, 2, 5, 9, 15], request)).to.equal(9);
        const twoSteps = parseRelativeRequest('Ventilator um 2 Stufen stärker', 'de')!;
        expect(enumRelativeTarget(2, [0, 2, 5, 9, 15], twoSteps)).to.equal(9);
        expect(enumRelativeTarget(2, [0, 2, 5, 9, 15], twoSteps, { inverted: true })).to.equal(0);
        expect(enumRelativeTarget(2, [0, 2, 5, 9, 15], twoSteps, { enabled: false })).to.equal(undefined);
    });
});

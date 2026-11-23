import { expect } from 'chai';
import { adjustHexColor } from '../src/commands/ColorAdjust';
import { parseRelativeRequest } from '../src/commands/RelativeValue';

describe('RGB relative color', () => {
    it('changes saturation without changing hue and preserves the RGBW white channel', () => {
        const request = parseRelativeRequest('Mach die Lampe etwas satter', 'de')!;
        expect(adjustHexColor('#804040', 'level.color.rgb', 'saturation', request)).to.equal('#803a3a');
        expect(adjustHexColor('#8040407f', 'level.color.rgbw', 'saturation', request)).to.equal('#803a3a7f');
        expect(adjustHexColor('#808080', 'level.color.rgb', 'saturation', request)).to.equal(undefined);
    });

    it('rejects an invalid current color and uses value for relative brightness', () => {
        const request = parseRelativeRequest('Mach die Lampe etwas heller', 'de')!;
        expect(adjustHexColor('red', 'level.color.rgb', 'brightness', request)).to.equal(undefined);
        expect(adjustHexColor('#800000', 'level.color.rgb', 'brightness', request)).to.equal('#8c0000');
    });
});

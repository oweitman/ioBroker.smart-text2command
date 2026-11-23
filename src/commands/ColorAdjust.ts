import type { RelativeProfile, RelativeRequest } from './RelativeValue';
import { relativeTarget } from './RelativeValue';

export function adjustHexColor(
    input: string,
    role: string,
    property: 'brightness' | 'saturation',
    request: RelativeRequest,
    profile: RelativeProfile = {},
): string | undefined {
    const length = role === 'level.color.rgb' ? 6 : role === 'level.color.rgbw' ? 8 : 0;
    if (!length || !new RegExp(`^#[0-9a-fA-F]{${length}}$`).test(input)) {
        return undefined;
    }
    const channels = [1, 3, 5].map(start => parseInt(input.slice(start, start + 2), 16) / 255);
    const maximum = Math.max(...channels);
    const minimum = Math.min(...channels);
    const spread = maximum - minimum;
    const saturation = maximum === 0 ? 0 : spread / maximum;
    const current = (property === 'brightness' ? maximum : saturation) * 100;
    const target = relativeTarget(current, 0, 100, property, '%', request, profile);
    if (target === undefined) {
        return undefined;
    }
    if (target === current) {
        return input;
    }
    if (property === 'saturation' && spread === 0 && target > current) {
        // A grayscale color has no hue. Increasing saturation would invent one.
        return undefined;
    }
    const value = property === 'brightness' ? target / 100 : maximum;
    const sat = property === 'saturation' ? target / 100 : saturation;
    let hue = 0;
    if (spread) {
        if (maximum === channels[0]) {
            hue = ((channels[1] - channels[2]) / spread) % 6;
        } else if (maximum === channels[1]) {
            hue = (channels[2] - channels[0]) / spread + 2;
        } else {
            hue = (channels[0] - channels[1]) / spread + 4;
        }
        hue = (hue * 60 + 360) % 360;
    }
    const chroma = value * sat;
    const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const offset = value - chroma;
    const segment = Math.floor(hue / 60) % 6;
    const components = (
        [
            [chroma, x, 0],
            [x, chroma, 0],
            [0, chroma, x],
            [0, x, chroma],
            [x, 0, chroma],
            [chroma, 0, x],
        ][segment] ?? [0, 0, 0]
    ).map(channel =>
        Math.max(0, Math.min(255, Math.round((channel + offset) * 255)))
            .toString(16)
            .padStart(2, '0'),
    );
    return `#${components.join('')}${length === 8 ? input.slice(7).toLowerCase() : ''}`;
}

export const REPEAT_MIN_PERIOD = 16;
export const REPEAT_MAX_PERIOD = 128;
export const REPEAT_COUNT = 4;
export const REPEAT_WINDOW = 512;

/** Return the repeated suffix's period, or 0 when the buffer has no 4-cycle. */
export function repeatPeriod(chars) {
	if (!Array.isArray(chars) || chars.length < REPEAT_MIN_PERIOD * REPEAT_COUNT) return 0;
	const max = Math.min(REPEAT_MAX_PERIOD, Math.floor(chars.length / REPEAT_COUNT));
	for (let period = REPEAT_MIN_PERIOD; period <= max; period += 1) {
		const start = chars.length - period * REPEAT_COUNT;
		let matches = true;
		for (let copy = 1; copy < REPEAT_COUNT && matches; copy += 1) {
			for (let offset = 0; offset < period; offset += 1) {
				if (chars[start + offset] !== chars[start + copy * period + offset]) {
					matches = false;
					break;
				}
			}
		}
		if (matches) return period;
	}
	return 0;
}

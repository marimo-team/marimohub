const crcTable = new Uint32Array(256).map((_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
	return value >>> 0;
});

export function updateCrc32(state: number, bytes: Uint8Array): number {
	let next = state;
	for (const byte of bytes) next = crcTable[(next ^ byte) & 0xff] ^ (next >>> 8);
	return next >>> 0;
}

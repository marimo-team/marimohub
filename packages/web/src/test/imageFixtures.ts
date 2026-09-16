export function pngHeader(width = 1200, height = 900) {
	const bytes = new Uint8Array(24);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
	bytes.set([73, 72, 68, 82], 12);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

export function pngFile(width = 1200, height = 900) {
	const bytes = pngHeader(width, height);
	const file = new File([bytes], 'screenshot.png', { type: 'image/png' });
	// jsdom's File lacks Blob.arrayBuffer().
	file.arrayBuffer = async () => bytes.buffer;
	return file;
}

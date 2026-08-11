import { StringDecoder } from 'node:string_decoder';

/** Keeps the most recent decoded characters without breaking split UTF-8 sequences. */
export class Utf8TailBuffer {
	private text = '';
	private readonly decoder = new StringDecoder('utf8');

	constructor(private readonly maxChars: number) {}

	append(chunk: Buffer): void {
		this.text += this.decoder.write(chunk);
		if (this.text.length > this.maxChars) {
			let start = this.text.length - this.maxChars;
			const code = this.text.charCodeAt(start);
			if (code >= 0xdc00 && code <= 0xdfff) start += 1;
			this.text = this.text.slice(start);
		}
	}

	toString(): string {
		return this.text;
	}
}

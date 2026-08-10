import { StringDecoder } from 'node:string_decoder';

/** Keeps the most recent decoded characters without breaking split UTF-8 sequences. */
export class Utf8TailBuffer {
	private text = '';
	private readonly decoder = new StringDecoder('utf8');

	constructor(private readonly maxChars: number) {}

	append(chunk: Buffer): void {
		this.text += this.decoder.write(chunk);
		if (this.text.length > this.maxChars) {
			this.text = this.text.slice(this.text.length - this.maxChars);
		}
	}

	toString(): string {
		return this.text;
	}
}

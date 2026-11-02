export function isAppleKeyboard(): boolean {
	return /Mac|iPhone|iPad/.test(navigator.platform);
}
